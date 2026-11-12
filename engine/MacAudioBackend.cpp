#ifdef __APPLE__

#include "AudioBackend.hpp"
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace ssm {

namespace {

std::string cfStringToStd(CFStringRef ref) {
  if (!ref) return "";
  char buf[512];
  if (CFStringGetCString(ref, buf, sizeof(buf), kCFStringEncodingUTF8)) {
    return std::string(buf);
  }
  return "";
}

int countStreamChannels(AudioDeviceID devId, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress addr{
      kAudioDevicePropertyStreamConfiguration,
      scope,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(devId, &addr, 0, nullptr, &size) != noErr || size == 0) {
    return 0;
  }
  std::vector<uint8_t> raw(size);
  auto* list = reinterpret_cast<AudioBufferList*>(raw.data());
  if (AudioObjectGetPropertyData(devId, &addr, 0, nullptr, &size, list) != noErr) {
    return 0;
  }
  int total = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; ++i) {
    total += static_cast<int>(list->mBuffers[i].mNumberChannels);
  }
  return total;
}

std::string getDeviceName(AudioDeviceID devId) {
  AudioObjectPropertyAddress addr{
      kAudioObjectPropertyName,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  CFStringRef cfName = nullptr;
  UInt32 size = sizeof(cfName);
  if (AudioObjectGetPropertyData(devId, &addr, 0, nullptr, &size, &cfName) == noErr && cfName) {
    std::string out = cfStringToStd(cfName);
    CFRelease(cfName);
    return out;
  }
  return "Unknown Device";
}

AudioDeviceID getDefaultDevice(AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress addr{
      selector,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  AudioDeviceID devId = kAudioObjectUnknown;
  UInt32 size = sizeof(devId);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, &devId);
  return devId;
}

class LockFreeRing {
public:
  explicit LockFreeRing(size_t capacityFloats = 65536) : buf_(capacityFloats, 0.0f) {}

  void write(const float* data, size_t count) {
    size_t w = writeIdx_.load(std::memory_order_relaxed);
    size_t cap = buf_.size();
    for (size_t i = 0; i < count; ++i) {
      buf_[(w + i) % cap] = data[i];
    }
    writeIdx_.store((w + count) % cap, std::memory_order_release);
  }

  size_t read(float* out, size_t count) {
    size_t r = readIdx_.load(std::memory_order_relaxed);
    size_t w = writeIdx_.load(std::memory_order_acquire);
    size_t cap = buf_.size();
    size_t avail = (w >= r) ? (w - r) : (cap - r + w);
    size_t n = std::min(avail, count);
    for (size_t i = 0; i < n; ++i) {
      out[i] = buf_[(r + i) % cap];
    }
    if (n < count) {
      std::fill(out + n, out + count, 0.0f);
    }
    readIdx_.store((r + n) % cap, std::memory_order_release);
    return n;
  }

  void clear() {
    readIdx_.store(0, std::memory_order_relaxed);
    writeIdx_.store(0, std::memory_order_relaxed);
  }

private:
  std::vector<float> buf_;
  std::atomic<size_t> readIdx_{0};
  std::atomic<size_t> writeIdx_{0};
};

} // namespace

class MacAudioBackend final : public AudioBackend {
public:
  ~MacAudioBackend() override { stop(); }

  std::vector<AudioDeviceInfo> listDevices() override {
    std::vector<AudioDeviceInfo> result;
    AudioObjectPropertyAddress addr{
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size) != noErr || size == 0) {
      return result;
    }
    size_t count = size / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> ids(count);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data()) != noErr) {
      return result;
    }

    AudioDeviceID defIn = getDefaultDevice(kAudioHardwarePropertyDefaultInputDevice);
    AudioDeviceID defOut = getDefaultDevice(kAudioHardwarePropertyDefaultOutputDevice);

    for (AudioDeviceID id : ids) {
      int inCh = countStreamChannels(id, kAudioDevicePropertyScopeInput);
      int outCh = countStreamChannels(id, kAudioDevicePropertyScopeOutput);
      if (inCh == 0 && outCh == 0) continue;

      AudioDeviceInfo info;
      info.id = std::to_string(id);
      info.name = getDeviceName(id);
      info.inputChannels = inCh;
      info.outputChannels = outCh;
      info.isDefaultInput = (id == defIn);
      info.isDefaultOutput = (id == defOut);
      result.push_back(std::move(info));
    }
    return result;
  }

  bool start(MixerEngine& engine,
             const std::string& inputDevId,
             const std::string& monitorOutDevId,
             const std::string& streamOutDevId,
             int bufferSize) override {
    stop();
    engine_ = &engine;
    bufferSize_ = std::clamp(bufferSize, 64, 2048);

    inDev_ = parseDeviceId(inputDevId, kAudioHardwarePropertyDefaultInputDevice, inputDevId == "none");
    monDev_ = parseDeviceId(monitorOutDevId, kAudioHardwarePropertyDefaultOutputDevice, monitorOutDevId == "none");
    streamDev_ = parseDeviceId(streamOutDevId, kAudioObjectUnknown, streamOutDevId == "none" || streamOutDevId.empty());

    inRing_.clear();
    streamRing_.clear();
    running_.store(true);

    // Try starting CoreAudio Monitor Output (drives main DSP block)
    if (monDev_ != kAudioObjectUnknown) {
      Float64 sr = 48000.0;
      UInt32 srSize = sizeof(sr);
      AudioObjectPropertyAddress srAddr{
          kAudioDevicePropertyNominalSampleRate,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      if (AudioObjectGetPropertyData(monDev_, &srAddr, 0, nullptr, &srSize, &sr) == noErr && sr > 8000.0) {
        engine_->setSampleRate(static_cast<float>(sr));
      }

      if (inDev_ != kAudioObjectUnknown) {
        inChannels_ = std::max(1, countStreamChannels(inDev_, kAudioDevicePropertyScopeInput));
        if (AudioDeviceCreateIOProcID(inDev_, &MacAudioBackend::inputIoProc, this, &inProcId_) == noErr) {
          AudioDeviceStart(inDev_, inProcId_);
        } else {
          inProcId_ = nullptr;
        }
      }

      if (AudioDeviceCreateIOProcID(monDev_, &MacAudioBackend::outputIoProc, this, &monProcId_) == noErr) {
        if (AudioDeviceStart(monDev_, monProcId_) == noErr) {
          if (streamDev_ != kAudioObjectUnknown && streamDev_ != monDev_) {
            if (AudioDeviceCreateIOProcID(streamDev_, &MacAudioBackend::streamIoProc, this, &streamProcId_) == noErr) {
              AudioDeviceStart(streamDev_, streamProcId_);
            } else {
              streamProcId_ = nullptr;
            }
          }
          hwActive_ = true;
          status_ = "CoreAudio Live (" + std::to_string(static_cast<int>(engine_->sampleRate())) + " Hz)";
          return true;
        }
      }
    }

    // Fallback: software DSP clock (useful if no audio device is selected or in sandboxed headless mode)
    stopAudioUnitsOnly();
    hwActive_ = false;
    engine_->setSampleRate(48000.0f);
    status_ = "DSP Clock Mode (48 kHz · Pilih Audio Device untuk Live I/O)";
    simThread_ = std::thread([this]() {
      const size_t frames = 512;
      std::vector<float> sL(frames), sR(frames), mL(frames), mR(frames);
      while (running_.load()) {
        engine_->processBlock(nullptr, 0, frames, sL.data(), sR.data(), mL.data(), mR.data());
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
    });
    return true;
  }

  void stop() override {
    running_.store(false);
    if (simThread_.joinable()) {
      simThread_.join();
    }
    stopAudioUnitsOnly();
    hwActive_ = false;
    status_ = "Stopped";
  }

  bool isRunning() const override { return running_.load(); }
  std::string statusText() const override { return status_; }

private:
  AudioDeviceID parseDeviceId(const std::string& idStr, AudioObjectPropertySelector fallbackSelector, bool explicitNone) {
    if (explicitNone) return kAudioObjectUnknown;
    if (idStr.empty() || idStr == "default") {
      if (fallbackSelector == kAudioObjectUnknown) return kAudioObjectUnknown;
      return getDefaultDevice(fallbackSelector);
    }
    try {
      return static_cast<AudioDeviceID>(std::stoul(idStr));
    } catch (...) {
      return kAudioObjectUnknown;
    }
  }

  void stopAudioUnitsOnly() {
    if (streamDev_ != kAudioObjectUnknown && streamProcId_) {
      AudioDeviceStop(streamDev_, streamProcId_);
      AudioDeviceDestroyIOProcID(streamDev_, streamProcId_);
      streamProcId_ = nullptr;
    }
    if (monDev_ != kAudioObjectUnknown && monProcId_) {
      AudioDeviceStop(monDev_, monProcId_);
      AudioDeviceDestroyIOProcID(monDev_, monProcId_);
      monProcId_ = nullptr;
    }
    if (inDev_ != kAudioObjectUnknown && inProcId_) {
      AudioDeviceStop(inDev_, inProcId_);
      AudioDeviceDestroyIOProcID(inDev_, inProcId_);
      inProcId_ = nullptr;
    }
  }

  static OSStatus inputIoProc(AudioDeviceID,
                              const AudioTimeStamp*,
                              const AudioBufferList* inData,
                              const AudioTimeStamp*,
                              AudioBufferList*,
                              const AudioTimeStamp*,
                              void* clientData) {
    auto* self = static_cast<MacAudioBackend*>(clientData);
    if (!self->running_.load(std::memory_order_relaxed) || !inData || inData->mNumberBuffers == 0) {
      return noErr;
    }
    const auto& buf = inData->mBuffers[0];
    if (!buf.mData || buf.mDataByteSize == 0) return noErr;
    size_t floatCount = buf.mDataByteSize / sizeof(float);
    self->inRing_.write(static_cast<const float*>(buf.mData), floatCount);
    return noErr;
  }

  static OSStatus outputIoProc(AudioDeviceID,
                               const AudioTimeStamp*,
                               const AudioBufferList*,
                               const AudioTimeStamp*,
                               AudioBufferList* outData,
                               const AudioTimeStamp*,
                               void* clientData) {
    auto* self = static_cast<MacAudioBackend*>(clientData);
    if (!self->running_.load(std::memory_order_relaxed) || !outData || outData->mNumberBuffers == 0) {
      return noErr;
    }

    auto& buf = outData->mBuffers[0];
    if (!buf.mData || buf.mDataByteSize == 0) return noErr;
    int outCh = std::max(1, static_cast<int>(buf.mNumberChannels));
    size_t frames = buf.mDataByteSize / (sizeof(float) * outCh);
    float* outPtr = static_cast<float*>(buf.mData);

    if (self->scratchSL_.size() < frames) {
      self->scratchSL_.resize(frames);
      self->scratchSR_.resize(frames);
      self->scratchML_.resize(frames);
      self->scratchMR_.resize(frames);
      self->scratchIn_.resize(frames * 16);
      self->scratchStreamInterleaved_.resize(frames * 2);
    }

    int hwInCh = self->inProcId_ ? self->inChannels_ : 0;
    if (hwInCh > 0) {
      size_t need = frames * static_cast<size_t>(hwInCh);
      if (self->scratchIn_.size() < need) self->scratchIn_.resize(need);
      self->inRing_.read(self->scratchIn_.data(), need);
    }

    self->engine_->processBlock(
        hwInCh > 0 ? self->scratchIn_.data() : nullptr,
        hwInCh,
        frames,
        self->scratchSL_.data(),
        self->scratchSR_.data(),
        self->scratchML_.data(),
        self->scratchMR_.data());

    // Push Stream Mix to separate OBS/TTLS virtual cable if configured
    if (self->streamProcId_) {
      for (size_t i = 0; i < frames; ++i) {
        self->scratchStreamInterleaved_[i * 2] = self->scratchSL_[i];
        self->scratchStreamInterleaved_[i * 2 + 1] = self->scratchSR_[i];
      }
      self->streamRing_.write(self->scratchStreamInterleaved_.data(), frames * 2);
    }

    // Write Monitor Mix to primary output device
    for (size_t i = 0; i < frames; ++i) {
      outPtr[i * outCh] = self->scratchML_[i];
      if (outCh > 1) outPtr[i * outCh + 1] = self->scratchMR_[i];
      for (int c = 2; c < outCh; ++c) outPtr[i * outCh + c] = 0.0f;
    }

    return noErr;
  }

  static OSStatus streamIoProc(AudioDeviceID,
                               const AudioTimeStamp*,
                               const AudioBufferList*,
                               const AudioTimeStamp*,
                               AudioBufferList* outData,
                               const AudioTimeStamp*,
                               void* clientData) {
    auto* self = static_cast<MacAudioBackend*>(clientData);
    if (!self->running_.load(std::memory_order_relaxed) || !outData || outData->mNumberBuffers == 0) {
      return noErr;
    }
    auto& buf = outData->mBuffers[0];
    if (!buf.mData || buf.mDataByteSize == 0) return noErr;
    int outCh = std::max(1, static_cast<int>(buf.mNumberChannels));
    size_t frames = buf.mDataByteSize / (sizeof(float) * outCh);
    float* outPtr = static_cast<float*>(buf.mData);

    if (self->scratchStreamRead_.size() < frames * 2) {
      self->scratchStreamRead_.resize(frames * 2);
    }
    self->streamRing_.read(self->scratchStreamRead_.data(), frames * 2);

    for (size_t i = 0; i < frames; ++i) {
      outPtr[i * outCh] = self->scratchStreamRead_[i * 2];
      if (outCh > 1) outPtr[i * outCh + 1] = self->scratchStreamRead_[i * 2 + 1];
      for (int c = 2; c < outCh; ++c) outPtr[i * outCh + c] = 0.0f;
    }
    return noErr;
  }

  MixerEngine* engine_ = nullptr;
  int bufferSize_ = 256;
  int inChannels_ = 2;
  AudioDeviceID inDev_ = kAudioObjectUnknown;
  AudioDeviceID monDev_ = kAudioObjectUnknown;
  AudioDeviceID streamDev_ = kAudioObjectUnknown;
  AudioDeviceIOProcID inProcId_ = nullptr;
  AudioDeviceIOProcID monProcId_ = nullptr;
  AudioDeviceIOProcID streamProcId_ = nullptr;

  LockFreeRing inRing_{131072};
  LockFreeRing streamRing_{131072};
  std::vector<float> scratchSL_, scratchSR_, scratchML_, scratchMR_, scratchIn_;
  std::vector<float> scratchStreamInterleaved_, scratchStreamRead_;

  std::atomic<bool> running_{false};
  bool hwActive_ = false;
  std::thread simThread_;
  std::string status_ = "Idle";
};

AudioBackend* createPlatformAudioBackend() {
  return new MacAudioBackend();
}

} // namespace ssm

#endif // __APPLE__
