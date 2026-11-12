#pragma once

#include "DspMath.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

namespace ssm {

inline bool loadWavStereo(const std::string& path,
                          std::vector<float>& outLeft,
                          std::vector<float>& outRight,
                          uint32_t targetSampleRate = 48000) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return false;

  char riff[12]{};
  file.read(riff, 12);
  if (std::string(riff, 4) != "RIFF" || std::string(riff + 8, 4) != "WAVE") return false;

  uint16_t audioFormat = 1;
  uint16_t numChannels = 2;
  uint32_t wavSampleRate = 48000;
  uint16_t bitsPerSample = 16;
  std::vector<uint8_t> pcmData;

  while (file.good()) {
    char chunkId[4]{};
    uint32_t chunkSize = 0;
    file.read(chunkId, 4);
    file.read(reinterpret_cast<char*>(&chunkSize), 4);
    if (!file.good()) break;

    std::string id(chunkId, 4);
    if (id == "fmt ") {
      std::vector<uint8_t> fmt(chunkSize);
      file.read(reinterpret_cast<char*>(fmt.data()), chunkSize);
      if (chunkSize >= 16) {
        audioFormat = *reinterpret_cast<uint16_t*>(&fmt[0]);
        numChannels = *reinterpret_cast<uint16_t*>(&fmt[2]);
        wavSampleRate = *reinterpret_cast<uint32_t*>(&fmt[4]);
        bitsPerSample = *reinterpret_cast<uint16_t*>(&fmt[14]);
      }
    } else if (id == "data") {
      pcmData.resize(chunkSize);
      file.read(reinterpret_cast<char*>(pcmData.data()), chunkSize);
    } else {
      file.seekg(chunkSize, std::ios::cur);
    }
    if (chunkSize & 1) file.seekg(1, std::ios::cur);
  }

  if (pcmData.empty() || (audioFormat != 1 && audioFormat != 3)) return false;
  size_t bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample == 0 || numChannels == 0 || wavSampleRate == 0) return false;
  size_t frameCount = pcmData.size() / (bytesPerSample * numChannels);
  if (frameCount == 0) return false;

  std::vector<float> srcL(frameCount);
  std::vector<float> srcR(frameCount);

  for (size_t i = 0; i < frameCount; ++i) {
    auto readSample = [&](int ch) -> float {
      size_t offset = (i * numChannels + ch) * bytesPerSample;
      if (offset + bytesPerSample > pcmData.size()) return 0.0f;
      if (audioFormat == 3 && bitsPerSample == 32) {
        return *reinterpret_cast<float*>(&pcmData[offset]);
      }
      if (bitsPerSample == 16) {
        int16_t v = *reinterpret_cast<int16_t*>(&pcmData[offset]);
        return static_cast<float>(v) / 32768.0f;
      }
      if (bitsPerSample == 24) {
        int32_t v = (pcmData[offset] | (pcmData[offset + 1] << 8) | (pcmData[offset + 2] << 16));
        if (v & 0x800000) v |= 0xFF000000;
        return static_cast<float>(v) / 8388608.0f;
      }
      if (bitsPerSample == 32) {
        int32_t v = *reinterpret_cast<int32_t*>(&pcmData[offset]);
        return static_cast<float>(static_cast<double>(v) / 2147483648.0);
      }
      return 0.0f;
    };
    srcL[i] = readSample(0);
    srcR[i] = (numChannels > 1) ? readSample(1) : srcL[i];
  }

  if (targetSampleRate == 0 || wavSampleRate == targetSampleRate) {
    outLeft = std::move(srcL);
    outRight = std::move(srcR);
    return true;
  }

  double ratio = static_cast<double>(wavSampleRate) / static_cast<double>(targetSampleRate);
  size_t outCount = std::max<size_t>(1, static_cast<size_t>(frameCount / ratio));
  outLeft.resize(outCount);
  outRight.resize(outCount);
  for (size_t i = 0; i < outCount; ++i) {
    double srcPos = i * ratio;
    size_t idx0 = std::min(frameCount - 1, static_cast<size_t>(srcPos));
    size_t idx1 = std::min(frameCount - 1, idx0 + 1);
    float frac = static_cast<float>(srcPos - idx0);
    outLeft[i] = srcL[idx0] + (srcL[idx1] - srcL[idx0]) * frac;
    outRight[i] = srcR[idx0] + (srcR[idx1] - srcR[idx0]) * frac;
  }
  return true;
}

struct SampleSlot {
  std::vector<float> left;
  std::vector<float> right;
  float gainDb = 0.0f;
  std::string name;
};

struct ActiveVoice {
  int padIndex = -1;
  size_t pos = 0;
  float gain = 1.0f;
  bool active = false;
};

class Soundboard {
public:
  static constexpr int kMaxPads = 16;
  static constexpr int kMaxVoices = 8;

  Soundboard() {
    initDefaultSynthSamples(48000.0f);
  }

  void initDefaultSynthSamples(float sampleRate) {
    std::lock_guard<std::mutex> lock(mutex_);
    const float freqs[8] = {523.25f, 587.33f, 659.25f, 783.99f, 880.0f, 1046.5f, 329.63f, 220.0f};
    const char* names[8] = {"Intro", "Applause", "Bell", "Airhorn", "Whoosh", "Rimshot", "Laugh", "Drop"};

    for (int i = 0; i < kMaxPads; ++i) {
      SampleSlot& slot = slots_[i];
      if (!slot.left.empty()) continue;
      slot.name = (i < 8) ? names[i] : ("Pad " + std::to_string(i + 1));

      size_t len = static_cast<size_t>(sampleRate * 0.45f);
      slot.left.resize(len);
      slot.right.resize(len);
      float baseFreq = freqs[i % 8];
      for (size_t n = 0; n < len; ++n) {
        float t = static_cast<float>(n) / sampleRate;
        float env = std::exp(-t * 7.5f);
        float s = (std::sin(2.0f * kPi * baseFreq * t) * 0.6f +
                   std::sin(2.0f * kPi * (baseFreq * 1.5f) * t) * 0.25f) *
                  env * 0.35f;
        slot.left[n] = s;
        slot.right[n] = s;
      }
    }
  }

  bool loadWav(int padIndex, const std::string& path, const std::string& label) {
    if (padIndex < 0 || padIndex >= kMaxPads) return false;
    std::vector<float> left, right;
    if (!loadWavStereo(path, left, right, 48000)) return false;

    std::lock_guard<std::mutex> lock(mutex_);
    slots_[padIndex].left = std::move(left);
    slots_[padIndex].right = std::move(right);
    if (!label.empty()) slots_[padIndex].name = label;
    return true;
  }

  void trigger(int padIndex, float gainDb = 0.0f) {
    if (padIndex < 0 || padIndex >= kMaxPads) return;
    std::lock_guard<std::mutex> lock(mutex_);
    if (slots_[padIndex].left.empty()) return;

    for (auto& voice : voices_) {
      if (!voice.active) {
        voice.padIndex = padIndex;
        voice.pos = 0;
        voice.gain = dbToLinear(gainDb);
        voice.active = true;
        return;
      }
    }
    voices_[0] = {padIndex, 0, dbToLinear(gainDb), true};
  }

  void stopAll() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& voice : voices_) voice.active = false;
  }

  void mixStereo(float* outL, float* outR, size_t frames) {
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return;

    for (auto& voice : voices_) {
      if (!voice.active) continue;
      const auto& slot = slots_[voice.padIndex];
      size_t avail = slot.left.size();
      for (size_t i = 0; i < frames; ++i) {
        if (voice.pos >= avail) {
          voice.active = false;
          break;
        }
        outL[i] += slot.left[voice.pos] * voice.gain;
        outR[i] += slot.right[voice.pos] * voice.gain;
        ++voice.pos;
      }
    }
  }

private:
  std::array<SampleSlot, kMaxPads> slots_;
  std::array<ActiveVoice, kMaxVoices> voices_;
  std::mutex mutex_;
};

class BgmPlayer {
public:
  std::atomic<bool> playing{false};
  std::atomic<bool> loop{true};

  bool loadWav(const std::string& path, uint32_t targetSampleRate) {
    std::vector<float> left, right;
    if (!loadWavStereo(path, left, right, targetSampleRate)) return false;

    std::lock_guard<std::mutex> lock(mutex_);
    left_ = std::move(left);
    right_ = std::move(right);
    pos_ = 0;
    return true;
  }

  void restart() {
    std::lock_guard<std::mutex> lock(mutex_);
    pos_ = 0;
  }

  void renderStereo(float* outL, float* outR, size_t frames) {
    if (!playing.load(std::memory_order_relaxed)) return;
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return;
    size_t total = left_.size();
    if (total == 0) return;

    bool doLoop = loop.load(std::memory_order_relaxed);
    for (size_t i = 0; i < frames; ++i) {
      if (pos_ >= total) {
        if (doLoop) {
          pos_ = 0;
        } else {
          playing.store(false, std::memory_order_relaxed);
          break;
        }
      }
      outL[i] += left_[pos_];
      outR[i] += right_[pos_];
      ++pos_;
    }
  }

private:
  std::vector<float> left_;
  std::vector<float> right_;
  size_t pos_ = 0;
  std::mutex mutex_;
};

} // namespace ssm
