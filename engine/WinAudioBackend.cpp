#ifdef _WIN32

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "AudioBackend.hpp"
#include <windows.h>
#include <initguid.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <functiondiscoverykeys_devpkey.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace ssm {

namespace {

std::string wideToUtf8(const wchar_t* wstr) {
  if (!wstr) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1) return "";
  std::string out(static_cast<size_t>(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wstr, -1, out.data(), len, nullptr, nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string& str) {
  if (str.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
  if (len <= 1) return L"";
  std::wstring out(static_cast<size_t>(len - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, out.data(), len);
  return out;
}

class WinRing {
public:
  explicit WinRing(size_t cap = 131072) : data_(cap, 0.0f), cap_(cap) {}

  void clear() {
    readIdx_.store(0, std::memory_order_relaxed);
    writeIdx_.store(0, std::memory_order_relaxed);
  }

  size_t available() const {
    return writeIdx_.load(std::memory_order_acquire) - readIdx_.load(std::memory_order_acquire);
  }

  void write(const float* src, size_t count) {
    size_t w = writeIdx_.load(std::memory_order_relaxed);
    size_t r = readIdx_.load(std::memory_order_acquire);
    size_t freeSpace = cap_ - (w - r);
    size_t n = std::min(count, freeSpace);
    for (size_t i = 0; i < n; ++i) {
      data_[(w + i) % cap_] = src[i];
    }
    writeIdx_.store(w + n, std::memory_order_release);
  }

  size_t read(float* dst, size_t count) {
    size_t r = readIdx_.load(std::memory_order_relaxed);
    size_t w = writeIdx_.load(std::memory_order_acquire);
    size_t avail = w - r;
    size_t n = std::min(count, avail);
    for (size_t i = 0; i < n; ++i) {
      dst[i] = data_[(r + i) % cap_];
    }
    if (n < count) {
      std::fill(dst + n, dst + count, 0.0f);
    }
    readIdx_.store(r + n, std::memory_order_release);
    return n;
  }

private:
  std::vector<float> data_;
  size_t cap_;
  std::atomic<size_t> readIdx_{0};
  std::atomic<size_t> writeIdx_{0};
};

// Minimal COM IASIO ABI definition (matches Steinberg ASIO x64 COM vtable)
#pragma pack(push, 4)
struct AsioBufferInfo {
  long isInput;
  long channelNum;
  void* buffers[2];
};

struct AsioChannelInfo {
  long channel;
  long isInput;
  long isActive;
  long channelGroup;
  long type;
  char name[32];
};

struct AsioCallbacks {
  void (*bufferSwitch)(long doubleBufferIndex, long directProcess);
  void (*sampleRateDidChange)(double sRate);
  long (*asioMessage)(long selector, long value, void* message, double* opt);
  void* (*bufferSwitchTimeInfo)(void* params, long doubleBufferIndex, long directProcess);
};
#pragma pack(pop)

struct IASIO : public IUnknown {
  virtual long init(void* sysHandle) = 0;
  virtual void getDriverName(char* name) = 0;
  virtual long getDriverVersion() = 0;
  virtual void getErrorMessage(char* string) = 0;
  virtual long start() = 0;
  virtual long stop() = 0;
  virtual long getChannels(long* numInputChannels, long* numOutputChannels) = 0;
  virtual long getLatencies(long* inputLatency, long* outputLatency) = 0;
  virtual long getBufferSize(long* minSize, long* maxSize, long* preferredSize, long* granularity) = 0;
  virtual long canSampleRate(double sampleRate) = 0;
  virtual long getSampleRate(double* sampleRate) = 0;
  virtual long setSampleRate(double sampleRate) = 0;
  virtual long getClockSources(void* clocks, long* numSources) = 0;
  virtual long setClockSource(long reference) = 0;
  virtual long getSamplePosition(void* sPos, void* tStamp) = 0;
  virtual long getChannelInfo(AsioChannelInfo* info) = 0;
  virtual long createBuffers(AsioBufferInfo* bufferInfos, long numChannels, long bufferSize, AsioCallbacks* callbacks) = 0;
  virtual long disposeBuffers() = 0;
  virtual long controlPanel() = 0;
  virtual long future(long selector, void* opt) = 0;
  virtual long outputReady() = 0;
};

constexpr long kAsioInt16LSB = 16;
constexpr long kAsioInt24LSB = 17;
constexpr long kAsioInt32LSB = 18;
constexpr long kAsioFloat32LSB = 19;

struct AsioHost {
  IASIO* driver = nullptr;
  long numIn = 0;
  long numOut = 0;
  long bufSize = 256;
  double sampleRate = 48000.0;
  std::vector<AsioBufferInfo> bufInfos;
  std::vector<long> inTypes;
  std::vector<long> outTypes;
  std::vector<float> tmpIn;
  std::vector<float> tmpOut;
  WinRing inRing{131072};
  WinRing outRing{131072};
  std::atomic<bool> active{false};
  std::string driverName;

  static AsioHost*& instancePtr() {
    static AsioHost* ptr = nullptr;
    return ptr;
  }

  static void onBufferSwitch(long doubleBufferIndex, long) {
    AsioHost* self = instancePtr();
    if (!self || !self->active.load(std::memory_order_relaxed)) return;

    const long frames = self->bufSize;
    const long inCh = self->numIn;
    const long outCh = self->numOut;

    if (inCh > 0 && static_cast<long>(self->tmpIn.size()) >= frames * inCh) {
      for (long f = 0; f < frames; ++f) {
        for (long c = 0; c < inCh; ++c) {
          void* ptr = self->bufInfos[c].buffers[doubleBufferIndex];
          long st = self->inTypes[c];
          float val = 0.0f;
          if (ptr) {
            if (st == kAsioInt16LSB) {
              val = static_cast<float>(reinterpret_cast<const int16_t*>(ptr)[f]) / 32768.0f;
            } else if (st == kAsioInt24LSB) {
              const uint8_t* p = reinterpret_cast<const uint8_t*>(ptr) + f * 3;
              int32_t s = static_cast<int32_t>((static_cast<uint32_t>(p[0])) |
                                               (static_cast<uint32_t>(p[1]) << 8) |
                                               (static_cast<uint32_t>(static_cast<int8_t>(p[2])) << 16));
              val = static_cast<float>(s) / 8388608.0f;
            } else if (st == kAsioInt32LSB) {
              val = static_cast<float>(reinterpret_cast<const int32_t*>(ptr)[f]) / 2147483648.0f;
            } else if (st == kAsioFloat32LSB) {
              val = reinterpret_cast<const float*>(ptr)[f];
            }
          }
          self->tmpIn[f * inCh + c] = val;
        }
      }
      self->inRing.write(self->tmpIn.data(), static_cast<size_t>(frames * inCh));
    }

    if (outCh > 0 && static_cast<long>(self->tmpOut.size()) >= frames * outCh) {
      self->outRing.read(self->tmpOut.data(), static_cast<size_t>(frames * outCh));
      for (long c = 0; c < outCh; ++c) {
        void* ptr = self->bufInfos[inCh + c].buffers[doubleBufferIndex];
        long st = self->outTypes[c];
        if (!ptr) continue;
        for (long f = 0; f < frames; ++f) {
          float s = std::clamp(self->tmpOut[f * outCh + c], -1.0f, 1.0f);
          if (st == kAsioInt16LSB) {
            reinterpret_cast<int16_t*>(ptr)[f] = static_cast<int16_t>(s * 32767.0f);
          } else if (st == kAsioInt24LSB) {
            int32_t v = static_cast<int32_t>(s * 8388607.0f);
            uint8_t* p = reinterpret_cast<uint8_t*>(ptr) + f * 3;
            p[0] = static_cast<uint8_t>(v & 0xFF);
            p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
            p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
          } else if (st == kAsioInt32LSB) {
            reinterpret_cast<int32_t*>(ptr)[f] = static_cast<int32_t>(s * 2147483647.0f);
          } else if (st == kAsioFloat32LSB) {
            reinterpret_cast<float*>(ptr)[f] = s;
          }
        }
      }
    }

    if (self->driver) self->driver->outputReady();
  }

  static void onSampleRateDidChange(double sRate) {
    if (instancePtr()) instancePtr()->sampleRate = sRate;
  }

  static long onAsioMessage(long selector, long, void*, double*) {
    if (selector == 1) return 1; // kAsioSelectorSupported
    if (selector == 2) return 1; // kAsioEngineVersion
    if (selector == 7) return 1; // kAsioSupportsTimeInfo
    return 0;
  }

  static void* onBufferSwitchTimeInfo(void*, long doubleBufferIndex, long directProcess) {
    onBufferSwitch(doubleBufferIndex, directProcess);
    return nullptr;
  }

  bool open(const std::string& clsidStr, int requestedSr, int requestedBuf) {
    close();
    CLSID clsid{};
    if (FAILED(CLSIDFromString(utf8ToWide(clsidStr).c_str(), &clsid))) return false;

    IASIO* drv = nullptr;
    if (FAILED(CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER, clsid, reinterpret_cast<void**>(&drv))) || !drv) {
      return false;
    }

    if (!drv->init(nullptr)) {
      drv->Release();
      return false;
    }

    char nameBuf[64] = {};
    drv->getDriverName(nameBuf);
    driverName = nameBuf[0] ? std::string(nameBuf) : "ASIO";

    long totalIn = 0, totalOut = 0;
    if (drv->getChannels(&totalIn, &totalOut) != 0) {
      drv->Release();
      return false;
    }
    numIn = std::clamp<long>(totalIn, 0, 8);
    numOut = std::clamp<long>(totalOut, 0, 8);
    if (numIn + numOut <= 0) {
      drv->Release();
      return false;
    }

    if (requestedSr > 8000 && drv->canSampleRate(static_cast<double>(requestedSr)) == 0) {
      drv->setSampleRate(static_cast<double>(requestedSr));
    }
    double curSr = 48000.0;
    if (drv->getSampleRate(&curSr) == 0 && curSr > 8000.0) {
      sampleRate = curSr;
    }

    long minSz = 64, maxSz = 2048, prefSz = 256, gran = 0;
    if (drv->getBufferSize(&minSz, &maxSz, &prefSz, &gran) == 0) {
      long target = (requestedBuf > 0) ? requestedBuf : prefSz;
      bufSize = std::clamp(target, std::max<long>(32, minSz), std::max<long>(minSz, maxSz));
    } else {
      bufSize = std::clamp<long>(requestedBuf > 0 ? requestedBuf : 256, 64, 1024);
    }

    bufInfos.resize(static_cast<size_t>(numIn + numOut));
    inTypes.assign(static_cast<size_t>(numIn), kAsioInt32LSB);
    outTypes.assign(static_cast<size_t>(numOut), kAsioInt32LSB);

    for (long c = 0; c < numIn; ++c) {
      bufInfos[c].isInput = 1;
      bufInfos[c].channelNum = c;
      bufInfos[c].buffers[0] = nullptr;
      bufInfos[c].buffers[1] = nullptr;
      AsioChannelInfo ci{};
      ci.channel = c;
      ci.isInput = 1;
      if (drv->getChannelInfo(&ci) == 0) inTypes[c] = ci.type;
    }
    for (long c = 0; c < numOut; ++c) {
      bufInfos[numIn + c].isInput = 0;
      bufInfos[numIn + c].channelNum = c;
      bufInfos[numIn + c].buffers[0] = nullptr;
      bufInfos[numIn + c].buffers[1] = nullptr;
      AsioChannelInfo ci{};
      ci.channel = c;
      ci.isInput = 0;
      if (drv->getChannelInfo(&ci) == 0) outTypes[c] = ci.type;
    }

    static AsioCallbacks callbacks{
        &AsioHost::onBufferSwitch,
        &AsioHost::onSampleRateDidChange,
        &AsioHost::onAsioMessage,
        &AsioHost::onBufferSwitchTimeInfo,
    };

    tmpIn.assign(static_cast<size_t>(bufSize * std::max<long>(1, numIn)), 0.0f);
    tmpOut.assign(static_cast<size_t>(bufSize * std::max<long>(1, numOut)), 0.0f);
    inRing.clear();
    outRing.clear();

    driver = drv;
    instancePtr() = this;
    if (drv->createBuffers(bufInfos.data(), numIn + numOut, bufSize, &callbacks) != 0) {
      close();
      return false;
    }

    active.store(true);
    if (drv->start() != 0) {
      close();
      return false;
    }
    return true;
  }

  void close() {
    active.store(false);
    if (driver) {
      driver->stop();
      driver->disposeBuffers();
      driver->Release();
      driver = nullptr;
    }
    if (instancePtr() == this) instancePtr() = nullptr;
    numIn = 0;
    numOut = 0;
  }
};

struct WasapiCaptureHandle {
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  UINT32 channels = 2;
  bool isFloat = true;
  WORD bitsPerSample = 32;
  bool isLoopback = false;
  bool isAsio = false;
  bool active = false;
  WinRing ring{131072};

  void release() {
    if (client) {
      client->Stop();
      client->Release();
      client = nullptr;
    }
    if (capture) {
      capture->Release();
      capture = nullptr;
    }
    active = false;
    isAsio = false;
  }
};

bool isFormatFloat(const WAVEFORMATEX* fmt) {
  if (!fmt) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt->cbSize >= 22) {
    const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
    return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != 0;
  }
  return false;
}

void pumpCaptureToRing(WasapiCaptureHandle& handle) {
  if (!handle.active || !handle.capture) return;

  UINT32 packetLen = 0;
  std::vector<float> scratch;
  while (SUCCEEDED(handle.capture->GetNextPacketSize(&packetLen)) && packetLen > 0) {
    BYTE* capData = nullptr;
    UINT32 numFrames = 0;
    DWORD flags = 0;
    if (FAILED(handle.capture->GetBuffer(&capData, &numFrames, &flags, nullptr, nullptr))) break;

    size_t samples = static_cast<size_t>(numFrames) * handle.channels;
    scratch.resize(samples);
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !capData) {
      std::fill(scratch.begin(), scratch.end(), 0.0f);
    } else if (handle.isFloat && handle.bitsPerSample == 32) {
      const float* fIn = reinterpret_cast<const float*>(capData);
      std::copy(fIn, fIn + samples, scratch.begin());
    } else if (handle.bitsPerSample == 16) {
      const int16_t* sIn = reinterpret_cast<const int16_t*>(capData);
      for (size_t i = 0; i < samples; ++i) scratch[i] = static_cast<float>(sIn[i]) / 32768.0f;
    } else if (handle.bitsPerSample == 32) {
      const int32_t* iIn = reinterpret_cast<const int32_t*>(capData);
      for (size_t i = 0; i < samples; ++i) scratch[i] = static_cast<float>(iIn[i]) / 2147483648.0f;
    } else {
      std::fill(scratch.begin(), scratch.end(), 0.0f);
    }

    handle.ring.write(scratch.data(), samples);
    handle.capture->ReleaseBuffer(numFrames);
  }
}

void collectAsioDevices(std::vector<AudioDeviceInfo>& list) {
  HKEY asioKey = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ, &asioKey) != ERROR_SUCCESS) {
    return;
  }

  wchar_t subName[256];
  for (DWORD idx = 0;; ++idx) {
    DWORD subLen = 256;
    if (RegEnumKeyExW(asioKey, idx, subName, &subLen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) {
      break;
    }

    HKEY drvKey = nullptr;
    if (RegOpenKeyExW(asioKey, subName, 0, KEY_READ, &drvKey) != ERROR_SUCCESS) continue;

    wchar_t clsidBuf[128] = {};
    DWORD clsidSize = sizeof(clsidBuf);
    DWORD type = 0;
    if (RegQueryValueExW(drvKey, L"CLSID", nullptr, &type, reinterpret_cast<LPBYTE>(clsidBuf), &clsidSize) == ERROR_SUCCESS &&
        clsidBuf[0]) {
      wchar_t descBuf[256] = {};
      DWORD descSize = sizeof(descBuf);
      std::string name = wideToUtf8(subName);
      if (RegQueryValueExW(drvKey, L"Description", nullptr, &type, reinterpret_cast<LPBYTE>(descBuf), &descSize) == ERROR_SUCCESS &&
          descBuf[0]) {
        name = wideToUtf8(descBuf);
      }

      AudioDeviceInfo info;
      info.id = "asio:" + wideToUtf8(clsidBuf);
      info.name = name + " (ASIO)";
      info.inputChannels = 2;
      info.outputChannels = 2;
      info.sampleRate = 48000.0;
      info.sampleRates = {44100, 48000, 88200, 96000};
      info.driver = "ASIO";
      list.push_back(std::move(info));
    }
    RegCloseKey(drvKey);
  }
  RegCloseKey(asioKey);
}

} // namespace

class WinAudioBackend final : public AudioBackend {
public:
  ~WinAudioBackend() override { stop(); }

  std::vector<AudioDeviceInfo> listDevices() override {
    std::vector<AudioDeviceInfo> list;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                   __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator))) &&
        enumerator) {
      auto collect = [&](EDataFlow flow, bool isInput) {
        IMMDevice* defDev = nullptr;
        std::string defId;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &defDev)) && defDev) {
          LPWSTR wid = nullptr;
          if (SUCCEEDED(defDev->GetId(&wid)) && wid) {
            defId = wideToUtf8(wid);
            CoTaskMemFree(wid);
          }
          defDev->Release();
        }

        IMMDeviceCollection* col = nullptr;
        if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col)) || !col) return;
        UINT count = 0;
        col->GetCount(&count);
        for (UINT i = 0; i < count; ++i) {
          IMMDevice* dev = nullptr;
          if (FAILED(col->Item(i, &dev)) || !dev) continue;

          LPWSTR wid = nullptr;
          std::string id;
          if (SUCCEEDED(dev->GetId(&wid)) && wid) {
            id = wideToUtf8(wid);
            CoTaskMemFree(wid);
          }

          IPropertyStore* props = nullptr;
          std::string name = "WASAPI Device";
          if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
            PROPVARIANT varName;
            PropVariantInit(&varName);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &varName)) && varName.vt == VT_LPWSTR) {
              name = wideToUtf8(varName.pwszVal);
            }
            PropVariantClear(&varName);
            props->Release();
          }

          AudioDeviceInfo info;
          info.id = id;
          info.name = name;
          info.inputChannels = isInput ? 2 : 0;
          info.outputChannels = isInput ? 0 : 2;
          info.isDefaultInput = isInput && (id == defId);
          info.isDefaultOutput = !isInput && (id == defId);
          info.driver = "WASAPI";
          info.sampleRate = 48000.0;

          IAudioClient* probeClient = nullptr;
          if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&probeClient))) &&
              probeClient) {
            WAVEFORMATEX* mixFmt = nullptr;
            if (SUCCEEDED(probeClient->GetMixFormat(&mixFmt)) && mixFmt) {
              info.sampleRate = static_cast<double>(mixFmt->nSamplesPerSec);
              if (isInput) info.inputChannels = std::max<int>(1, static_cast<int>(mixFmt->nChannels));
              else info.outputChannels = std::max<int>(1, static_cast<int>(mixFmt->nChannels));

              const int candidates[] = {44100, 48000, 88200, 96000};
              std::vector<uint8_t> fmtCopy(sizeof(WAVEFORMATEX) + mixFmt->cbSize);
              for (int cand : candidates) {
                std::memcpy(fmtCopy.data(), mixFmt, fmtCopy.size());
                auto* testFmt = reinterpret_cast<WAVEFORMATEX*>(fmtCopy.data());
                testFmt->nSamplesPerSec = static_cast<DWORD>(cand);
                testFmt->nAvgBytesPerSec = testFmt->nSamplesPerSec * testFmt->nBlockAlign;
                WAVEFORMATEX* closest = nullptr;
                HRESULT sup = probeClient->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, testFmt, &closest);
                if (closest) CoTaskMemFree(closest);
                if (sup == S_OK || static_cast<int>(mixFmt->nSamplesPerSec) == cand) {
                  info.sampleRates.push_back(cand);
                }
              }
              if (info.sampleRates.empty()) {
                info.sampleRates.push_back(static_cast<int>(mixFmt->nSamplesPerSec));
              }
              CoTaskMemFree(mixFmt);
            }
            probeClient->Release();
          }
          if (info.sampleRates.empty()) {
            info.sampleRates.push_back(48000);
          }

          list.push_back(info);

          // Expose Windows Render endpoints as native WASAPI Loopback capture sources too
          if (!isInput) {
            AudioDeviceInfo lb = info;
            lb.id = "loopback:" + id;
            lb.name = name + " (Loopback)";
            lb.inputChannels = std::max(2, info.outputChannels);
            lb.outputChannels = 0;
            lb.isDefaultInput = false;
            lb.isDefaultOutput = false;
            lb.driver = "WASAPI Loopback";
            list.push_back(std::move(lb));
          }

          dev->Release();
        }
        col->Release();
      };

      collect(eCapture, true);
      collect(eRender, false);
      enumerator->Release();
    }

    collectAsioDevices(list);
    return list;
  }

  bool start(MixerEngine& engine,
             const std::string& inputDevId,
             const std::string& musicInputDevId,
             const std::string& monitorOutDevId,
             const std::string& streamOutDevId,
             int bufferSize,
             int sampleRate = 0) override {
    std::vector<std::string> inputs;
    inputs.push_back(inputDevId);
    if (!musicInputDevId.empty() && musicInputDevId != "none") {
      inputs.push_back(musicInputDevId);
    }
    return startMulti(engine, inputs, monitorOutDevId, streamOutDevId, bufferSize, sampleRate);
  }

  bool startMulti(MixerEngine& engine,
                  const std::vector<std::string>& inputDevIds,
                  const std::string& monitorOutDevId,
                  const std::string& streamOutDevId,
                  int bufferSize,
                  int sampleRate = 0) override {
    stop();
    engine_ = &engine;
    float initialSr = (sampleRate > 8000) ? static_cast<float>(sampleRate) : 48000.0f;
    engine_->setSampleRate(initialSr);
    running_.store(true);
    status_ = "WASAPI Live (" + std::to_string(static_cast<int>(initialSr)) + " Hz)";

    std::vector<std::string> inIds = inputDevIds;
    if (inIds.empty()) inIds.push_back("default");

    worker_ = std::thread([this, inIds, monitorOutDevId, streamOutDevId, bufferSize, sampleRate]() {
      CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      IMMDeviceEnumerator* enumerator = nullptr;
      CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                       __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));

      // Check if an ASIO device was requested in any input or output
      AsioHost asio;
      std::string asioClsid;
      auto findAsio = [](const std::string& id) -> std::string {
        if (id.rfind("asio:", 0) == 0) return id.substr(5);
        return "";
      };
      for (const auto& id : inIds) {
        if (asioClsid.empty()) asioClsid = findAsio(id);
      }
      if (asioClsid.empty()) asioClsid = findAsio(monitorOutDevId);
      if (asioClsid.empty()) asioClsid = findAsio(streamOutDevId);

      bool asioOpen = false;
      if (!asioClsid.empty()) {
        asioOpen = asio.open(asioClsid, sampleRate, bufferSize);
        if (asioOpen) {
          engine_->setSampleRate(static_cast<float>(asio.sampleRate));
          status_ = "ASIO + WASAPI (" + std::to_string(static_cast<int>(asio.sampleRate)) + " Hz · " + asio.driverName + ")";
        }
      }

      auto openRender = [&](const std::string& devId,
                            IAudioClient** outClient,
                            IAudioRenderClient** outRender,
                            UINT32* outFrames,
                            UINT32* outChannels,
                            bool* outIsFloat,
                            WORD* outBits) {
        if (!enumerator || devId == "none" || devId.empty() || devId.rfind("asio:", 0) == 0) return false;
        IMMDevice* dev = nullptr;
        HRESULT hr = (devId == "default")
                         ? enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &dev)
                         : enumerator->GetDevice(utf8ToWide(devId).c_str(), &dev);
        if (FAILED(hr) || !dev) return false;

        hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(outClient));
        dev->Release();
        if (FAILED(hr) || !*outClient) return false;

        WAVEFORMATEX* mixFmt = nullptr;
        (*outClient)->GetMixFormat(&mixFmt);
        if (mixFmt) {
          if (sampleRate > 8000 && static_cast<int>(mixFmt->nSamplesPerSec) != sampleRate) {
            mixFmt->nSamplesPerSec = static_cast<DWORD>(sampleRate);
            mixFmt->nAvgBytesPerSec = mixFmt->nSamplesPerSec * mixFmt->nBlockAlign;
          }
          WAVEFORMATEX* closest = nullptr;
          HRESULT sup = (*outClient)->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, mixFmt, &closest);
          WAVEFORMATEX* initFmt = (sup == S_FALSE && closest) ? closest : mixFmt;
          if (!asioOpen) {
            engine_->setSampleRate(static_cast<float>(initFmt->nSamplesPerSec));
            status_ = "WASAPI Live (" + std::to_string(initFmt->nSamplesPerSec) + " Hz)";
          }
          *outChannels = std::max<UINT32>(1, initFmt->nChannels);
          *outIsFloat = isFormatFloat(initFmt);
          *outBits = initFmt->wBitsPerSample;
          REFERENCE_TIME dur = 200000;
          hr = (*outClient)->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, dur, 0, initFmt, nullptr);
          if (closest) CoTaskMemFree(closest);
          CoTaskMemFree(mixFmt);
          if (FAILED(hr)) return false;
        } else {
          return false;
        }

        (*outClient)->GetBufferSize(outFrames);
        (*outClient)->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(outRender));
        (*outClient)->Start();
        return (*outRender != nullptr);
      };

      auto openCapture = [&](const std::string& devId, WasapiCaptureHandle& out) {
        if (devId == "none" || devId.empty()) return false;
        if (devId.rfind("asio:", 0) == 0) {
          if (asioOpen && devId.substr(5) == asioClsid && asio.numIn > 0) {
            out.isAsio = true;
            out.channels = static_cast<UINT32>(asio.numIn);
            out.active = true;
            return true;
          }
          return false;
        }
        if (!enumerator) return false;

        bool loopback = (devId.rfind("loopback:", 0) == 0);
        std::string realId = loopback ? devId.substr(9) : devId;
        EDataFlow flow = loopback ? eRender : eCapture;

        IMMDevice* dev = nullptr;
        HRESULT hr = (realId == "default")
                         ? enumerator->GetDefaultAudioEndpoint(flow, eConsole, &dev)
                         : enumerator->GetDevice(utf8ToWide(realId).c_str(), &dev);
        if (FAILED(hr) || !dev) return false;

        hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&out.client));
        dev->Release();
        if (FAILED(hr) || !out.client) return false;

        WAVEFORMATEX* mixFmt = nullptr;
        out.client->GetMixFormat(&mixFmt);
        if (mixFmt) {
          out.channels = std::max<UINT32>(1, mixFmt->nChannels);
          out.isFloat = isFormatFloat(mixFmt);
          out.bitsPerSample = mixFmt->wBitsPerSample;
        }
        DWORD flags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        REFERENCE_TIME dur = 200000;
        hr = out.client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, dur, 0, mixFmt, nullptr);
        if (mixFmt) CoTaskMemFree(mixFmt);
        if (FAILED(hr)) return false;

        out.client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&out.capture));
        out.client->Start();
        out.isLoopback = loopback;
        out.active = (out.capture != nullptr);
        return out.active;
      };

      std::array<WasapiCaptureHandle, MixerEngine::kMaxInputSlots> capSlots;
      for (size_t s = 0; s < inIds.size() && s < MixerEngine::kMaxInputSlots; ++s) {
        std::string id = (s == 0 && inIds[s].empty()) ? "default" : inIds[s];
        openCapture(id, capSlots[s]);
      }

      bool monIsAsio = asioOpen && (monitorOutDevId.rfind("asio:", 0) == 0) && (monitorOutDevId.substr(5) == asioClsid);
      bool strIsAsio = asioOpen && (streamOutDevId.rfind("asio:", 0) == 0) && (streamOutDevId.substr(5) == asioClsid);

      IAudioClient* monClient = nullptr;
      IAudioRenderClient* monRender = nullptr;
      UINT32 monBufFrames = 480;
      UINT32 monChannels = 2;
      bool monFloat = true;
      WORD monBits = 32;
      bool hasMon = !monIsAsio &&
                    openRender(monitorOutDevId.empty() ? "default" : monitorOutDevId,
                               &monClient, &monRender, &monBufFrames, &monChannels, &monFloat, &monBits);

      IAudioClient* strClient = nullptr;
      IAudioRenderClient* strRender = nullptr;
      UINT32 strBufFrames = 480;
      UINT32 strChannels = 2;
      bool strFloat = true;
      WORD strBits = 32;
      bool hasStr = !strIsAsio &&
                    (streamOutDevId != monitorOutDevId) &&
                    openRender(streamOutDevId, &strClient, &strRender, &strBufFrames, &strChannels, &strFloat, &strBits);

      const size_t maxBlock = static_cast<size_t>(std::clamp(bufferSize, 64, 1024));
      std::array<std::vector<float>, MixerEngine::kMaxInputSlots> inBufs;
      for (int s = 0; s < MixerEngine::kMaxInputSlots; ++s) {
        inBufs[s].assign(maxBlock * 8, 0.0f);
      }
      std::vector<float> sL(maxBlock), sR(maxBlock), mL(maxBlock), mR(maxBlock);
      std::vector<float> asioOutInterleaved(maxBlock * std::max<long>(2, asio.numOut), 0.0f);

      while (running_.load()) {
        for (int s = 0; s < MixerEngine::kMaxInputSlots; ++s) {
          if (capSlots[s].active && !capSlots[s].isAsio) {
            pumpCaptureToRing(capSlots[s]);
          }
        }

        size_t frames = maxBlock;
        if (hasMon && monClient) {
          UINT32 pad = 0;
          monClient->GetCurrentPadding(&pad);
          UINT32 avail = (monBufFrames > pad) ? (monBufFrames - pad) : 0;
          if (avail < 64) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
          }
          frames = std::min<size_t>(avail, maxBlock);
        } else if (asioOpen && (monIsAsio || strIsAsio)) {
          size_t outCh = static_cast<size_t>(std::max<long>(1, asio.numOut));
          size_t target = static_cast<size_t>(asio.bufSize * 2) * outCh;
          if (asio.outRing.available() >= target) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
          }
          frames = std::min<size_t>(static_cast<size_t>(asio.bufSize), maxBlock);
        }

        std::array<MixerEngine::CaptureSource, MixerEngine::kMaxInputSlots> sources{};
        for (int s = 0; s < MixerEngine::kMaxInputSlots; ++s) {
          if (!capSlots[s].active) continue;
          size_t ch = capSlots[s].channels;
          size_t need = frames * ch;
          if (inBufs[s].size() < need) inBufs[s].resize(need);
          if (capSlots[s].isAsio) {
            asio.inRing.read(inBufs[s].data(), need);
          } else {
            capSlots[s].ring.read(inBufs[s].data(), need);
          }
          sources[s] = {inBufs[s].data(), static_cast<int>(ch)};
        }

        engine_->processBlockMulti(
            sources.data(),
            MixerEngine::kMaxInputSlots,
            frames,
            sL.data(),
            sR.data(),
            mL.data(),
            mR.data());

        auto writeOut = [&](IAudioClient* client, IAudioRenderClient* render, UINT32 bufFrames, UINT32 chs,
                            bool isFlt, WORD bits, const std::vector<float>& left, const std::vector<float>& right) {
          if (!client || !render) return;
          UINT32 padding = 0;
          client->GetCurrentPadding(&padding);
          UINT32 avail = (bufFrames > padding) ? (bufFrames - padding) : 0;
          UINT32 writeFrames = std::min<UINT32>(avail, static_cast<UINT32>(frames));
          BYTE* data = nullptr;
          if (writeFrames > 0 && SUCCEEDED(render->GetBuffer(writeFrames, &data)) && data) {
            if (isFlt && bits == 32) {
              float* f = reinterpret_cast<float*>(data);
              for (UINT32 i = 0; i < writeFrames; ++i) {
                if (chs == 1) {
                  f[i] = 0.5f * (left[i] + right[i]);
                } else {
                  f[i * chs] = left[i];
                  f[i * chs + 1] = right[i];
                  for (UINT32 c = 2; c < chs; ++c) f[i * chs + c] = 0.0f;
                }
              }
            } else if (bits == 16) {
              int16_t* s16 = reinterpret_cast<int16_t*>(data);
              for (UINT32 i = 0; i < writeFrames; ++i) {
                float l = std::clamp(left[i], -1.0f, 1.0f);
                float r = std::clamp(right[i], -1.0f, 1.0f);
                if (chs == 1) {
                  s16[i] = static_cast<int16_t>(0.5f * (l + r) * 32767.0f);
                } else {
                  s16[i * chs] = static_cast<int16_t>(l * 32767.0f);
                  s16[i * chs + 1] = static_cast<int16_t>(r * 32767.0f);
                  for (UINT32 c = 2; c < chs; ++c) s16[i * chs + c] = 0;
                }
              }
            }
            render->ReleaseBuffer(writeFrames, 0);
          }
        };

        if (hasMon) writeOut(monClient, monRender, monBufFrames, monChannels, monFloat, monBits, mL, mR);
        if (hasStr) writeOut(strClient, strRender, strBufFrames, strChannels, strFloat, strBits, sL, sR);

        if (asioOpen && (monIsAsio || strIsAsio) && asio.numOut > 0) {
          size_t outCh = static_cast<size_t>(asio.numOut);
          asioOutInterleaved.assign(frames * outCh, 0.0f);
          const auto& srcL = monIsAsio ? mL : sL;
          const auto& srcR = monIsAsio ? mR : sR;
          for (size_t i = 0; i < frames; ++i) {
            asioOutInterleaved[i * outCh] = srcL[i];
            if (outCh > 1) asioOutInterleaved[i * outCh + 1] = srcR[i];
          }
          asio.outRing.write(asioOutInterleaved.data(), frames * outCh);
        }

        if (!hasMon && !asioOpen) {
          std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
      }

      for (auto& c : capSlots) c.release();
      asio.close();
      if (monClient) { monClient->Stop(); monClient->Release(); }
      if (monRender) monRender->Release();
      if (strClient) { strClient->Stop(); strClient->Release(); }
      if (strRender) strRender->Release();
      if (enumerator) enumerator->Release();
      CoUninitialize();
    });
    return true;
  }

  void stop() override {
    running_.store(false);
    if (worker_.joinable()) {
      worker_.join();
    }
    status_ = "Stopped";
  }

  bool isRunning() const override { return running_.load(); }
  std::string statusText() const override { return status_; }

private:
  MixerEngine* engine_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread worker_;
  std::string status_ = "Idle";
};

AudioBackend* createPlatformAudioBackend() {
  return new WinAudioBackend();
}

} // namespace ssm

#endif
