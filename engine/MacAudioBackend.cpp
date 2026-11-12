#ifdef __APPLE__

#include "AudioBackend.hpp"
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <objc/message.h>
#include <objc/runtime.h>
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
  if (devId == kAudioObjectUnknown) return "None";
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

double getDeviceNominalSampleRate(AudioDeviceID devId) {
  if (devId == kAudioObjectUnknown) return 48000.0;
  AudioObjectPropertyAddress addr{
      kAudioDevicePropertyNominalSampleRate,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  Float64 sr = 48000.0;
  UInt32 size = sizeof(sr);
  if (AudioObjectGetPropertyData(devId, &addr, 0, nullptr, &size, &sr) == noErr && sr > 8000.0) {
    return static_cast<double>(sr);
  }
  return 48000.0;
}

std::vector<int> getDeviceSupportedSampleRates(AudioDeviceID devId) {
  std::vector<int> rates;
  if (devId == kAudioObjectUnknown) return rates;
  AudioObjectPropertyAddress addr{
      kAudioDevicePropertyAvailableNominalSampleRates,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(devId, &addr, 0, nullptr, &size) != noErr || size == 0) {
    rates.push_back(static_cast<int>(getDeviceNominalSampleRate(devId)));
    return rates;
  }
  size_t count = size / sizeof(AudioValueRange);
  std::vector<AudioValueRange> ranges(count);
  if (AudioObjectGetPropertyData(devId, &addr, 0, nullptr, &size, ranges.data()) != noErr) {
    rates.push_back(static_cast<int>(getDeviceNominalSampleRate(devId)));
    return rates;
  }
  const int candidates[] = {44100, 48000, 88200, 96000};
  for (int cand : candidates) {
    for (const auto& r : ranges) {
      if (cand >= r.mMinimum - 1.0 && cand <= r.mMaximum + 1.0) {
        rates.push_back(cand);
        break;
      }
    }
  }
  if (rates.empty()) {
    rates.push_back(static_cast<int>(getDeviceNominalSampleRate(devId)));
  }
  return rates;
}

void trySetDeviceSampleRate(AudioDeviceID devId, Float64 targetRate) {
  if (devId == kAudioObjectUnknown || targetRate <= 8000.0) return;
  AudioObjectPropertyAddress addr{
      kAudioDevicePropertyNominalSampleRate,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  AudioObjectSetPropertyData(devId, &addr, 0, nullptr, sizeof(targetRate), &targetRate);
}

void trySetDeviceBufferSize(AudioDeviceID devId, UInt32 frames) {
  if (devId == kAudioObjectUnknown || frames < 64) return;
  AudioObjectPropertyAddress addr{
      kAudioDevicePropertyBufferFrameSize,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  AudioObjectSetPropertyData(devId, &addr, 0, nullptr, sizeof(frames), &frames);
}

// Returns AVAuthorizationStatus: 0=NotDetermined, 1=Restricted, 2=Denied, 3=Authorized, -1=Unknown
int getMacMicAuthStatus() {
  static void* avHandle = dlopen("/System/Library/Frameworks/AVFoundation.framework/AVFoundation", RTLD_LAZY);
  if (!avHandle) return -1;
  Class cls = objc_getClass("AVCaptureDevice");
  Class nsStrCls = objc_getClass("NSString");
  if (!cls || !nsStrCls) return -1;

  SEL strSel = sel_registerName("stringWithUTF8String:");
  SEL authSel = sel_registerName("authorizationStatusForMediaType:");
  if (!class_getClassMethod(nsStrCls, strSel) || !class_getClassMethod(cls, authSel)) return -1;

  using StrFn = id (*)(Class, SEL, const char*);
  using AuthFn = long (*)(Class, SEL, id);
  id mediaAudio = reinterpret_cast<StrFn>(objc_msgSend)(nsStrCls, strSel, "soun");
  if (!mediaAudio) return -1;
  long st = reinterpret_cast<AuthFn>(objc_msgSend)(cls, authSel, mediaAudio);
  return static_cast<int>(st);
}

class LockFreeRing {
public:
  explicit LockFreeRing(size_t capacityFloats = 131072) : buf_(capacityFloats, 0.0f) {}

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
    if (avail > cap / 2) {
      // Keep low latency if capture drifted ahead
      size_t skip = avail - count;
      if (avail > count) r = (r + skip) % cap;
      avail = std::min(avail, count);
    }
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

void writeOutputBuffers(AudioBufferList* outData, const float* left, const float* right, size_t frames) {
  if (!outData || outData->mNumberBuffers == 0) return;
  if (outData->mNumberBuffers == 1) {
    auto& buf = outData->mBuffers[0];
    if (!buf.mData || buf.mDataByteSize == 0) return;
    int outCh = std::max(1, static_cast<int>(buf.mNumberChannels));
    size_t bufFrames = std::min(frames, buf.mDataByteSize / (sizeof(float) * outCh));
    float* outPtr = static_cast<float*>(buf.mData);
    for (size_t i = 0; i < bufFrames; ++i) {
      if (outCh == 1) {
        outPtr[i] = 0.5f * (left[i] + right[i]);
      } else {
        outPtr[i * outCh] = left[i];
        outPtr[i * outCh + 1] = right[i];
        for (int c = 2; c < outCh; ++c) outPtr[i * outCh + c] = 0.0f;
      }
    }
    return;
  }

  // Non-interleaved output buffers
  for (UInt32 b = 0; b < outData->mNumberBuffers; ++b) {
    auto& buf = outData->mBuffers[b];
    if (!buf.mData || buf.mDataByteSize == 0) continue;
    size_t bufFrames = std::min(frames, buf.mDataByteSize / sizeof(float));
    float* dst = static_cast<float*>(buf.mData);
    if (b == 0) std::memcpy(dst, left, bufFrames * sizeof(float));
    else if (b == 1) std::memcpy(dst, right, bufFrames * sizeof(float));
    else std::fill(dst, dst + bufFrames, 0.0f);
  }
}

struct InputCaptureSlot {
  AudioDeviceID devId = kAudioObjectUnknown;
  AudioDeviceIOProcID procId = nullptr;
  int channels = 2;
  bool isFloat = true;
  int bitsPerChannel = 32;
  double srcSampleRate = 48000.0;
  double dstSampleRate = 48000.0;
  std::atomic<bool>* runningFlag = nullptr;
  LockFreeRing ring{131072};
  std::vector<float> tmpInterleaved;
  std::vector<float> tmpResampled;

  void stop() {
    if (devId != kAudioObjectUnknown && procId) {
      AudioDeviceStop(devId, procId);
      AudioDeviceDestroyIOProcID(devId, procId);
      procId = nullptr;
    }
    devId = kAudioObjectUnknown;
  }

  bool start(AudioDeviceID id, double targetRate, std::atomic<bool>* running) {
    stop();
    ring.clear();
    runningFlag = running;
    dstSampleRate = (targetRate > 8000.0) ? targetRate : 48000.0;
    if (id == kAudioObjectUnknown) return false;

    int chCount = countStreamChannels(id, kAudioDevicePropertyScopeInput);
    if (chCount <= 0) return false;
    channels = chCount;

    // Ask input device to match output sample rate if possible
    AudioObjectPropertyAddress rateAddr{
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    Float64 desired = dstSampleRate;
    AudioObjectSetPropertyData(id, &rateAddr, 0, nullptr, sizeof(desired), &desired);

    AudioStreamBasicDescription asbd{};
    UInt32 asbdSize = sizeof(asbd);
    AudioObjectPropertyAddress fmtAddr{
        kAudioDevicePropertyStreamFormat,
        kAudioDevicePropertyScopeInput,
        kAudioObjectPropertyElementMain,
    };
    if (AudioObjectGetPropertyData(id, &fmtAddr, 0, nullptr, &asbdSize, &asbd) == noErr) {
      srcSampleRate = (asbd.mSampleRate > 8000.0) ? asbd.mSampleRate : dstSampleRate;
      isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
      bitsPerChannel = (asbd.mBitsPerChannel > 0) ? static_cast<int>(asbd.mBitsPerChannel) : 32;
    } else {
      srcSampleRate = dstSampleRate;
      isFloat = true;
      bitsPerChannel = 32;
    }

    devId = id;
    if (AudioDeviceCreateIOProcID(id, &InputCaptureSlot::ioProc, this, &procId) != noErr) {
      procId = nullptr;
      devId = kAudioObjectUnknown;
      return false;
    }
    if (AudioDeviceStart(id, procId) != noErr) {
      AudioDeviceDestroyIOProcID(id, procId);
      procId = nullptr;
      devId = kAudioObjectUnknown;
      return false;
    }
    return true;
  }

  static OSStatus ioProc(AudioDeviceID,
                         const AudioTimeStamp*,
                         const AudioBufferList* inData,
                         const AudioTimeStamp*,
                         AudioBufferList*,
                         const AudioTimeStamp*,
                         void* clientData) {
    auto* slot = static_cast<InputCaptureSlot*>(clientData);
    if (!slot || !slot->runningFlag || !slot->runningFlag->load(std::memory_order_relaxed)) return noErr;
    if (!inData || inData->mNumberBuffers == 0) return noErr;

    const int chTotal = std::max(1, slot->channels);
    const int bytesPerSample = std::max(1, slot->bitsPerChannel / 8);

    size_t inFrames = 0;
    if (inData->mNumberBuffers == 1) {
      const auto& b0 = inData->mBuffers[0];
      if (!b0.mData || b0.mDataByteSize == 0) return noErr;
      int bufCh = std::max(1, static_cast<int>(b0.mNumberChannels));
      inFrames = b0.mDataByteSize / (static_cast<size_t>(bytesPerSample) * bufCh);
    } else {
      const auto& b0 = inData->mBuffers[0];
      if (!b0.mData || b0.mDataByteSize == 0) return noErr;
      int bufCh = std::max(1, static_cast<int>(b0.mNumberChannels));
      inFrames = b0.mDataByteSize / (static_cast<size_t>(bytesPerSample) * bufCh);
    }
    if (inFrames == 0) return noErr;

    slot->tmpInterleaved.resize(inFrames * chTotal);

    auto readSample = [&](const void* base, size_t idx) -> float {
      if (slot->isFloat && slot->bitsPerChannel == 32) {
        return static_cast<const float*>(base)[idx];
      }
      if (!slot->isFloat && slot->bitsPerChannel == 16) {
        return static_cast<float>(static_cast<const int16_t*>(base)[idx]) / 32768.0f;
      }
      if (!slot->isFloat && slot->bitsPerChannel == 32) {
        return static_cast<float>(static_cast<double>(static_cast<const int32_t*>(base)[idx]) / 2147483648.0);
      }
      return 0.0f;
    };

    if (inData->mNumberBuffers == 1) {
      const auto& b0 = inData->mBuffers[0];
      int bufCh = std::max(1, static_cast<int>(b0.mNumberChannels));
      for (size_t f = 0; f < inFrames; ++f) {
        for (int c = 0; c < chTotal; ++c) {
          int sc = std::min(c, bufCh - 1);
          slot->tmpInterleaved[f * chTotal + c] = readSample(b0.mData, f * bufCh + sc);
        }
      }
    } else {
      // Planar / multi-buffer CoreAudio capture
      int chIdx = 0;
      for (UInt32 b = 0; b < inData->mNumberBuffers && chIdx < chTotal; ++b) {
        const auto& buf = inData->mBuffers[b];
        int bCh = std::max(1, static_cast<int>(buf.mNumberChannels));
        if (!buf.mData) {
          chIdx += bCh;
          continue;
        }
        for (int lc = 0; lc < bCh && chIdx < chTotal; ++lc, ++chIdx) {
          for (size_t f = 0; f < inFrames; ++f) {
            slot->tmpInterleaved[f * chTotal + chIdx] = readSample(buf.mData, f * bCh + lc);
          }
        }
      }
    }

    if (std::abs(slot->srcSampleRate - slot->dstSampleRate) < 10.0) {
      slot->ring.write(slot->tmpInterleaved.data(), inFrames * chTotal);
      return noErr;
    }

    // Linear sample-rate conversion when Mic hardware rate differs from Output rate
    double step = slot->srcSampleRate / slot->dstSampleRate;
    size_t outFrames = std::max<size_t>(1, static_cast<size_t>(static_cast<double>(inFrames) / step));
    slot->tmpResampled.resize(outFrames * chTotal);
    for (size_t f = 0; f < outFrames; ++f) {
      double pos = f * step;
      size_t i0 = std::min(inFrames - 1, static_cast<size_t>(pos));
      size_t i1 = std::min(inFrames - 1, i0 + 1);
      float frac = static_cast<float>(pos - i0);
      for (int c = 0; c < chTotal; ++c) {
        float s0 = slot->tmpInterleaved[i0 * chTotal + c];
        float s1 = slot->tmpInterleaved[i1 * chTotal + c];
        slot->tmpResampled[f * chTotal + c] = s0 + (s1 - s0) * frac;
      }
    }
    slot->ring.write(slot->tmpResampled.data(), outFrames * chTotal);
    return noErr;
  }
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
      info.sampleRate = getDeviceNominalSampleRate(id);
      info.sampleRates = getDeviceSupportedSampleRates(id);
      info.driver = "CoreAudio";
      result.push_back(std::move(info));
    }
    return result;
  }

  bool start(MixerEngine& engine,
             const std::string& inputDevId,
             const std::string& musicInputDevId,
             const std::string& monitorOutDevId,
             const std::string& streamOutDevId,
             int bufferSize,
             int sampleRate = 0) override {
    stop();
    engine_ = &engine;
    bufferSize_ = std::clamp(bufferSize, 64, 2048);

    AudioDeviceID inDev = parseDeviceId(inputDevId, kAudioHardwarePropertyDefaultInputDevice, inputDevId == "none");
    AudioDeviceID musicDev =
        parseDeviceId(musicInputDevId, kAudioObjectUnknown, musicInputDevId == "none" || musicInputDevId.empty());
    monDev_ = parseDeviceId(monitorOutDevId, kAudioHardwarePropertyDefaultOutputDevice, monitorOutDevId == "none");
    streamDev_ = parseDeviceId(streamOutDevId, kAudioObjectUnknown, streamOutDevId == "none" || streamOutDevId.empty());

    streamRing_.clear();
    running_.store(true);

    if (monDev_ != kAudioObjectUnknown) {
      if (sampleRate > 8000) {
        Float64 req = static_cast<Float64>(sampleRate);
        trySetDeviceSampleRate(monDev_, req);
        trySetDeviceSampleRate(streamDev_, req);
        trySetDeviceSampleRate(inDev, req);
        trySetDeviceSampleRate(musicDev, req);
      }
      trySetDeviceBufferSize(monDev_, static_cast<UInt32>(bufferSize_));
      trySetDeviceBufferSize(streamDev_, static_cast<UInt32>(bufferSize_));

      Float64 sr = getDeviceNominalSampleRate(monDev_);
      engine_->setSampleRate(static_cast<float>(sr));

      bool micActive = micCapture_.start(inDev, sr, &running_);
      bool musicActive = musicCapture_.start(musicDev, sr, &running_);

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
          int auth = getMacMicAuthStatus();
          std::string micTag = micActive ? ("Mic: " + getDeviceName(inDev)) : "Mic: Off";
          if (auth == 1 || auth == 2) {
            micTag = "Mic: Ditolak macOS (Cek Privacy)";
          }
          std::string bgmTag = musicActive ? (" · Loopback: " + getDeviceName(musicDev)) : "";
          status_ = "CoreAudio (" + std::to_string(static_cast<int>(engine_->sampleRate())) + " Hz · " + micTag +
                    bgmTag + ")";
          return true;
        }
      }
    }

    stopAudioUnitsOnly();
    hwActive_ = false;
    float fallbackSr = (sampleRate > 8000) ? static_cast<float>(sampleRate) : 48000.0f;
    engine_->setSampleRate(fallbackSr);
    status_ = "DSP Clock Mode (" + std::to_string(static_cast<int>(fallbackSr)) + " Hz · Pilih Audio Device)";
    simThread_ = std::thread([this]() {
      const size_t frames = 512;
      std::vector<float> sL(frames), sR(frames), mL(frames), mR(frames);
      while (running_.load()) {
        engine_->processBlock(nullptr, 0, nullptr, 0, frames, sL.data(), sR.data(), mL.data(), mR.data());
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
    micCapture_.stop();
    musicCapture_.stop();
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
    if (frames == 0) return noErr;

    if (self->scratchSL_.size() < frames) {
      self->scratchSL_.resize(frames);
      self->scratchSR_.resize(frames);
      self->scratchML_.resize(frames);
      self->scratchMR_.resize(frames);
      self->scratchIn_.resize(frames * 16);
      self->scratchMusic_.resize(frames * 16);
      self->scratchStreamInterleaved_.resize(frames * 2);
    }

    int micCh = self->micCapture_.procId ? self->micCapture_.channels : 0;
    if (micCh > 0) {
      size_t need = frames * static_cast<size_t>(micCh);
      if (self->scratchIn_.size() < need) self->scratchIn_.resize(need);
      self->micCapture_.ring.read(self->scratchIn_.data(), need);
    }

    int musCh = self->musicCapture_.procId ? self->musicCapture_.channels : 0;
    if (musCh > 0) {
      size_t need = frames * static_cast<size_t>(musCh);
      if (self->scratchMusic_.size() < need) self->scratchMusic_.resize(need);
      self->musicCapture_.ring.read(self->scratchMusic_.data(), need);
    }

    self->engine_->processBlock(
        micCh > 0 ? self->scratchIn_.data() : nullptr,
        micCh,
        musCh > 0 ? self->scratchMusic_.data() : nullptr,
        musCh,
        frames,
        self->scratchSL_.data(),
        self->scratchSR_.data(),
        self->scratchML_.data(),
        self->scratchMR_.data());

    if (self->streamProcId_) {
      for (size_t i = 0; i < frames; ++i) {
        self->scratchStreamInterleaved_[i * 2] = self->scratchSL_[i];
        self->scratchStreamInterleaved_[i * 2 + 1] = self->scratchSR_[i];
      }
      self->streamRing_.write(self->scratchStreamInterleaved_.data(), frames * 2);
    }

    writeOutputBuffers(outData, self->scratchML_.data(), self->scratchMR_.data(), frames);
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
    if (frames == 0) return noErr;

    if (self->scratchStreamRead_.size() < frames * 2) {
      self->scratchStreamRead_.resize(frames * 2);
    }
    if (self->scratchStreamOutL_.size() < frames) {
      self->scratchStreamOutL_.resize(frames);
      self->scratchStreamOutR_.resize(frames);
    }
    self->streamRing_.read(self->scratchStreamRead_.data(), frames * 2);
    for (size_t i = 0; i < frames; ++i) {
      self->scratchStreamOutL_[i] = self->scratchStreamRead_[i * 2];
      self->scratchStreamOutR_[i] = self->scratchStreamRead_[i * 2 + 1];
    }
    writeOutputBuffers(outData, self->scratchStreamOutL_.data(), self->scratchStreamOutR_.data(), frames);
    return noErr;
  }

  MixerEngine* engine_ = nullptr;
  int bufferSize_ = 256;
  AudioDeviceID monDev_ = kAudioObjectUnknown;
  AudioDeviceID streamDev_ = kAudioObjectUnknown;
  AudioDeviceIOProcID monProcId_ = nullptr;
  AudioDeviceIOProcID streamProcId_ = nullptr;

  InputCaptureSlot micCapture_;
  InputCaptureSlot musicCapture_;
  LockFreeRing streamRing_{131072};
  std::vector<float> scratchSL_, scratchSR_, scratchML_, scratchMR_, scratchIn_, scratchMusic_;
  std::vector<float> scratchStreamInterleaved_, scratchStreamRead_, scratchStreamOutL_, scratchStreamOutR_;

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
