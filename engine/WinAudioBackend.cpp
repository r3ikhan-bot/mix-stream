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
#include <functiondiscoverykeys_devpkey.h>
#include <algorithm>
#include <atomic>
#include <chrono>
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

struct WasapiCaptureHandle {
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  UINT32 channels = 2;
  bool active = false;

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
  }
};

void drainCapturePackets(WasapiCaptureHandle& handle, std::vector<float>& ring, size_t blockFrames) {
  std::fill(ring.begin(), ring.end(), 0.0f);
  if (!handle.active || !handle.capture) return;

  size_t filled = 0;
  UINT32 packetLen = 0;
  while (SUCCEEDED(handle.capture->GetNextPacketSize(&packetLen)) && packetLen > 0) {
    BYTE* capData = nullptr;
    UINT32 numFrames = 0;
    DWORD flags = 0;
    if (FAILED(handle.capture->GetBuffer(&capData, &numFrames, &flags, nullptr, nullptr))) break;

    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && capData) {
      const float* fIn = reinterpret_cast<const float*>(capData);
      for (UINT32 i = 0; i < numFrames && filled < blockFrames; ++i) {
        for (UINT32 ch = 0; ch < handle.channels; ++ch) {
          ring[filled * handle.channels + ch] = fIn[i * handle.channels + ch];
        }
        ++filled;
      }
    } else {
      filled = std::min(blockFrames, filled + static_cast<size_t>(numFrames));
    }
    handle.capture->ReleaseBuffer(numFrames);
    if (filled >= blockFrames) break;
  }
}

} // namespace

class WinAudioBackend final : public AudioBackend {
public:
  ~WinAudioBackend() override { stop(); }

  std::vector<AudioDeviceInfo> listDevices() override {
    std::vector<AudioDeviceInfo> list;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator)))) {
      return list;
    }

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
        list.push_back(std::move(info));
        dev->Release();
      }
      col->Release();
    };

    collect(eCapture, true);
    collect(eRender, false);
    enumerator->Release();
    return list;
  }

  bool start(MixerEngine& engine,
             const std::string& inputDevId,
             const std::string& musicInputDevId,
             const std::string& monitorOutDevId,
             const std::string& streamOutDevId,
             int bufferSize) override {
    stop();
    engine_ = &engine;
    engine_->setSampleRate(48000.0f);
    running_.store(true);
    status_ = "WASAPI Live (48000 Hz)";

    worker_ = std::thread([this, inputDevId, musicInputDevId, monitorOutDevId, streamOutDevId, bufferSize]() {
      CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      IMMDeviceEnumerator* enumerator = nullptr;
      CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                       __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));

      auto openRender = [&](const std::string& devId,
                            IAudioClient** outClient,
                            IAudioRenderClient** outRender,
                            UINT32* outFrames,
                            UINT32* outChannels) {
        if (!enumerator || devId == "none" || devId.empty()) return false;
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
          engine_->setSampleRate(static_cast<float>(mixFmt->nSamplesPerSec));
          *outChannels = std::max<UINT32>(1, mixFmt->nChannels);
        }
        REFERENCE_TIME dur = 200000;
        hr = (*outClient)->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, dur, 0, mixFmt, nullptr);
        if (mixFmt) CoTaskMemFree(mixFmt);
        if (FAILED(hr)) return false;

        (*outClient)->GetBufferSize(outFrames);
        (*outClient)->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(outRender));
        (*outClient)->Start();
        return (*outRender != nullptr);
      };

      auto openCapture = [&](const std::string& devId, WasapiCaptureHandle& out) {
        if (!enumerator || devId == "none" || devId.empty()) return false;
        IMMDevice* dev = nullptr;
        HRESULT hr = (devId == "default")
                         ? enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &dev)
                         : enumerator->GetDevice(utf8ToWide(devId).c_str(), &dev);
        if (FAILED(hr) || !dev) return false;

        hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&out.client));
        dev->Release();
        if (FAILED(hr) || !out.client) return false;

        WAVEFORMATEX* mixFmt = nullptr;
        out.client->GetMixFormat(&mixFmt);
        if (mixFmt) {
          out.channels = std::max<UINT32>(1, mixFmt->nChannels);
        }
        REFERENCE_TIME dur = 200000;
        hr = out.client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, dur, 0, mixFmt, nullptr);
        if (mixFmt) CoTaskMemFree(mixFmt);
        if (FAILED(hr)) return false;

        out.client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&out.capture));
        out.client->Start();
        out.active = (out.capture != nullptr);
        return out.active;
      };

      WasapiCaptureHandle micCap;
      openCapture(inputDevId.empty() ? "default" : inputDevId, micCap);

      WasapiCaptureHandle musicCap;
      if (musicInputDevId != inputDevId) {
        openCapture(musicInputDevId, musicCap);
      }

      IAudioClient* monClient = nullptr;
      IAudioRenderClient* monRender = nullptr;
      UINT32 monBufFrames = 480;
      UINT32 monChannels = 2;
      bool hasMon = openRender(monitorOutDevId.empty() ? "default" : monitorOutDevId,
                               &monClient, &monRender, &monBufFrames, &monChannels);

      IAudioClient* strClient = nullptr;
      IAudioRenderClient* strRender = nullptr;
      UINT32 strBufFrames = 480;
      UINT32 strChannels = 2;
      bool hasStr = (streamOutDevId != monitorOutDevId) &&
                    openRender(streamOutDevId, &strClient, &strRender, &strBufFrames, &strChannels);

      const size_t blockFrames = static_cast<size_t>(std::clamp(bufferSize, 128, 1024));
      std::vector<float> micRing(blockFrames * micCap.channels * 2, 0.0f);
      std::vector<float> musRing(blockFrames * musicCap.channels * 2, 0.0f);
      std::vector<float> sL(blockFrames), sR(blockFrames), mL(blockFrames), mR(blockFrames);

      while (running_.load()) {
        drainCapturePackets(micCap, micRing, blockFrames);
        drainCapturePackets(musicCap, musRing, blockFrames);

        engine_->processBlock(
            micCap.active ? micRing.data() : nullptr,
            micCap.active ? static_cast<int>(micCap.channels) : 0,
            musicCap.active ? musRing.data() : nullptr,
            musicCap.active ? static_cast<int>(musicCap.channels) : 0,
            blockFrames,
            sL.data(),
            sR.data(),
            mL.data(),
            mR.data());

        auto writeOut = [&](IAudioClient* client, IAudioRenderClient* render, UINT32 bufFrames, UINT32 chs,
                            const std::vector<float>& left, const std::vector<float>& right) {
          if (!client || !render) return;
          UINT32 padding = 0;
          client->GetCurrentPadding(&padding);
          UINT32 avail = (bufFrames > padding) ? (bufFrames - padding) : 0;
          UINT32 writeFrames = std::min<UINT32>(avail, static_cast<UINT32>(blockFrames));
          BYTE* data = nullptr;
          if (writeFrames > 0 && SUCCEEDED(render->GetBuffer(writeFrames, &data)) && data) {
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
            render->ReleaseBuffer(writeFrames, 0);
          }
        };

        if (hasMon) writeOut(monClient, monRender, monBufFrames, monChannels, mL, mR);
        if (hasStr) writeOut(strClient, strRender, strBufFrames, strChannels, sL, sR);

        std::this_thread::sleep_for(std::chrono::milliseconds(4));
      }

      micCap.release();
      musicCap.release();
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
    if (worker_.joinable()) worker_.join();
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

#endif // _WIN32
