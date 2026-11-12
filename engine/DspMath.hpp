#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

namespace ssm {

constexpr float kPi = 3.14159265358979323846f;

inline float dbToLinear(float db) {
  if (db <= -90.0f) return 0.0f;
  return std::pow(10.0f, db * 0.05f);
}

inline float linearToDb(float lin) {
  if (lin <= 1e-6f) return -96.0f;
  return 20.0f * std::log10(lin);
}

struct Biquad {
  float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
  float z1L = 0.0f, z2L = 0.0f;
  float z1R = 0.0f, z2R = 0.0f;

  void reset() {
    z1L = z2L = z1R = z2R = 0.0f;
  }

  void setIdentity() {
    b0 = 1.0f;
    b1 = b2 = a1 = a2 = 0.0f;
  }

  void setHighPass(float sampleRate, float freqHz, float q = 0.7071f) {
    float f = std::clamp(freqHz, 15.0f, sampleRate * 0.45f);
    float w0 = 2.0f * kPi * f / sampleRate;
    float cosW0 = std::cos(w0);
    float alpha = std::sin(w0) / (2.0f * q);
    float a0 = 1.0f + alpha;

    b0 = ((1.0f + cosW0) * 0.5f) / a0;
    b1 = (-(1.0f + cosW0)) / a0;
    b2 = ((1.0f + cosW0) * 0.5f) / a0;
    a1 = (-2.0f * cosW0) / a0;
    a2 = (1.0f - alpha) / a0;
  }

  void setLowShelf(float sampleRate, float freqHz, float gainDb, float slope = 0.8f) {
    if (std::abs(gainDb) < 0.05f) {
      setIdentity();
      return;
    }
    float A = std::pow(10.0f, gainDb / 40.0f);
    float w0 = 2.0f * kPi * std::clamp(freqHz, 20.0f, sampleRate * 0.45f) / sampleRate;
    float cosW0 = std::cos(w0);
    float sinW0 = std::sin(w0);
    float alpha = sinW0 * 0.5f * std::sqrt((A + 1.0f / A) * (1.0f / slope - 1.0f) + 2.0f);
    float twoSqrtAAlpha = 2.0f * std::sqrt(A) * alpha;

    float a0 = (A + 1.0f) + (A - 1.0f) * cosW0 + twoSqrtAAlpha;
    b0 = (A * ((A + 1.0f) - (A - 1.0f) * cosW0 + twoSqrtAAlpha)) / a0;
    b1 = (2.0f * A * ((A - 1.0f) - (A + 1.0f) * cosW0)) / a0;
    b2 = (A * ((A + 1.0f) - (A - 1.0f) * cosW0 - twoSqrtAAlpha)) / a0;
    a1 = (-2.0f * ((A - 1.0f) + (A + 1.0f) * cosW0)) / a0;
    a2 = ((A + 1.0f) + (A - 1.0f) * cosW0 - twoSqrtAAlpha) / a0;
  }

  void setHighShelf(float sampleRate, float freqHz, float gainDb, float slope = 0.8f) {
    if (std::abs(gainDb) < 0.05f) {
      setIdentity();
      return;
    }
    float A = std::pow(10.0f, gainDb / 40.0f);
    float w0 = 2.0f * kPi * std::clamp(freqHz, 20.0f, sampleRate * 0.45f) / sampleRate;
    float cosW0 = std::cos(w0);
    float sinW0 = std::sin(w0);
    float alpha = sinW0 * 0.5f * std::sqrt((A + 1.0f / A) * (1.0f / slope - 1.0f) + 2.0f);
    float twoSqrtAAlpha = 2.0f * std::sqrt(A) * alpha;

    float a0 = (A + 1.0f) - (A - 1.0f) * cosW0 + twoSqrtAAlpha;
    b0 = (A * ((A + 1.0f) + (A - 1.0f) * cosW0 + twoSqrtAAlpha)) / a0;
    b1 = (-2.0f * A * ((A - 1.0f) + (A + 1.0f) * cosW0)) / a0;
    b2 = (A * ((A + 1.0f) + (A - 1.0f) * cosW0 - twoSqrtAAlpha)) / a0;
    a1 = (2.0f * ((A - 1.0f) - (A + 1.0f) * cosW0)) / a0;
    a2 = ((A + 1.0f) - (A - 1.0f) * cosW0 - twoSqrtAAlpha) / a0;
  }

  void setPeaking(float sampleRate, float freqHz, float gainDb, float q = 1.1f) {
    if (std::abs(gainDb) < 0.05f) {
      setIdentity();
      return;
    }
    float A = std::pow(10.0f, gainDb / 40.0f);
    float w0 = 2.0f * kPi * std::clamp(freqHz, 20.0f, sampleRate * 0.45f) / sampleRate;
    float cosW0 = std::cos(w0);
    float alpha = std::sin(w0) / (2.0f * q);

    float a0 = 1.0f + alpha / A;
    b0 = (1.0f + alpha * A) / a0;
    b1 = (-2.0f * cosW0) / a0;
    b2 = (1.0f - alpha * A) / a0;
    a1 = (-2.0f * cosW0) / a0;
    a2 = (1.0f - alpha / A) / a0;
  }

  inline void processStereo(float& l, float& r) {
    float outL = b0 * l + z1L;
    z1L = b1 * l - a1 * outL + z2L;
    z2L = b2 * l - a2 * outL;
    l = outL;

    float outR = b0 * r + z1R;
    z1R = b1 * r - a1 * outR + z2R;
    z2R = b2 * r - a2 * outR;
    r = outR;
  }
};

struct NoiseGate {
  float env = 0.0f;
  float gain = 1.0f;

  inline void process(float& l, float& r, float thresholdDb, float sampleRate, bool enabled) {
    if (!enabled) {
      gain = 1.0f;
      return;
    }
    float level = std::max(std::abs(l), std::abs(r));
    float coeff = (level > env) ? std::exp(-1.0f / (0.002f * sampleRate))
                                : std::exp(-1.0f / (0.120f * sampleRate));
    env = coeff * env + (1.0f - coeff) * level;

    float threshLin = dbToLinear(thresholdDb);
    float target = (env >= threshLin) ? 1.0f : 0.05f;
    float gCoeff = (target > gain) ? std::exp(-1.0f / (0.003f * sampleRate))
                                   : std::exp(-1.0f / (0.140f * sampleRate));
    gain = gCoeff * gain + (1.0f - gCoeff) * target;
    l *= gain;
    r *= gain;
  }
};

struct Compressor {
  float envDb = -96.0f;
  float gainReductionDb = 0.0f;

  inline void process(float& l, float& r, float thresholdDb, float ratio, float makeupDb,
                      float sampleRate, bool enabled) {
    if (!enabled) {
      gainReductionDb = 0.0f;
      return;
    }
    float peak = std::max(std::abs(l), std::abs(r));
    float inDb = linearToDb(peak);
    float coeff = (inDb > envDb) ? std::exp(-1.0f / (0.005f * sampleRate))
                                 : std::exp(-1.0f / (0.090f * sampleRate));
    envDb = coeff * envDb + (1.0f - coeff) * inDb;

    float overDb = envDb - thresholdDb;
    float gr = 0.0f;
    if (overDb > 0.0f && ratio > 1.0f) {
      gr = overDb * (1.0f - 1.0f / ratio);
    }
    gainReductionDb = gr;
    float totalGain = dbToLinear(-gr + makeupDb);
    l *= totalGain;
    r *= totalGain;
  }
};

struct SimpleStereoReverb {
  static constexpr int kBufSize = 4096;
  std::array<std::array<float, kBufSize>, 4> combL{};
  std::array<std::array<float, kBufSize>, 4> combR{};
  std::array<int, 4> idxL{0, 0, 0, 0};
  std::array<int, 4> idxR{0, 0, 0, 0};
  std::array<int, 4> lenL{1557, 1617, 1491, 1422};
  std::array<int, 4> lenR{1580, 1640, 1514, 1445};
  float dampL = 0.0f;
  float dampR = 0.0f;

  inline void process(float inL, float inR, float& outL, float& outR, float decay = 0.78f) {
    float sumL = 0.0f;
    float sumR = 0.0f;
    float fb = std::clamp(decay, 0.2f, 0.88f);

    for (int i = 0; i < 4; ++i) {
      int pL = idxL[i];
      float yL = combL[i][pL];
      dampL = yL * 0.7f + dampL * 0.3f;
      combL[i][pL] = inL + dampL * fb;
      idxL[i] = (pL + 1) % lenL[i];
      sumL += yL;

      int pR = idxR[i];
      float yR = combR[i][pR];
      dampR = yR * 0.7f + dampR * 0.3f;
      combR[i][pR] = inR + dampR * fb;
      idxR[i] = (pR + 1) % lenR[i];
      sumR += yR;
    }

    outL = sumL * 0.22f;
    outR = sumR * 0.22f;
  }
};

struct DeEsser {
  Biquad sidechainHp;
  float lastFreqHz = -1.0f;
  float env = 0.0f;
  float gain = 1.0f;

  inline void process(float& l, float& r, float freqParam, float amountParam, float sampleRate) {
    float freqHz = 4500.0f + std::clamp(freqParam, 0.0f, 1.0f) * 4500.0f;
    if (std::abs(freqHz - lastFreqHz) > 25.0f) {
      sidechainHp.setHighPass(sampleRate, freqHz, 1.2f);
      lastFreqHz = freqHz;
    }

    float scL = l;
    float scR = r;
    sidechainHp.processStereo(scL, scR);
    float sibilance = std::max(std::abs(scL), std::abs(scR));

    float atk = std::exp(-1.0f / (0.0015f * sampleRate));
    float rel = std::exp(-1.0f / (0.045f * sampleRate));
    env = (sibilance > env) ? (atk * env + (1.0f - atk) * sibilance)
                            : (rel * env + (1.0f - rel) * sibilance);

    float thresh = 0.035f;
    float amount = std::clamp(amountParam, 0.0f, 1.0f);
    float targetGain = 1.0f;
    if (env > thresh && amount > 0.01f) {
      float excess = (env - thresh) / (env + 1e-5f);
      targetGain = std::max(0.25f, 1.0f - excess * amount * 0.85f);
    }
    gain = 0.96f * gain + 0.04f * targetGain;
    l *= gain;
    r *= gain;
  }
};

struct VocalWarmth {
  Biquad presenceShelf;
  float lastTone = -1.0f;

  inline void process(float& l, float& r, float driveParam, float toneParam, float sampleRate) {
    float drive = 1.0f + std::clamp(driveParam, 0.0f, 1.0f) * 2.5f;
    float bias = 0.06f * std::clamp(driveParam, 0.0f, 1.0f);
    float norm = 1.0f / std::tanh(drive);
    float offset = std::tanh(bias * drive);

    l = (std::tanh((l + bias) * drive) - offset) * norm;
    r = (std::tanh((r + bias) * drive) - offset) * norm;

    float toneDb = (std::clamp(toneParam, 0.0f, 1.0f) - 0.35f) * 8.0f;
    if (std::abs(toneDb - lastTone) > 0.1f) {
      presenceShelf.setHighShelf(sampleRate, 3800.0f, toneDb, 0.75f);
      lastTone = toneDb;
    }
    presenceShelf.processStereo(l, r);
  }
};

struct StereoDelay {
  static constexpr int kMaxSamples = 96000;
  std::vector<float> bufL;
  std::vector<float> bufR;
  int writePos = 0;

  StereoDelay() : bufL(kMaxSamples, 0.0f), bufR(kMaxSamples, 0.0f) {}

  inline void process(float& l, float& r, float timeParam, float feedbackMixParam, float sampleRate) {
    float ms = 80.0f + std::clamp(timeParam, 0.0f, 1.0f) * 520.0f;
    int delaySamples = std::clamp(static_cast<int>(ms * 0.001f * sampleRate), 64, kMaxSamples - 1);
    int delayR = std::clamp(static_cast<int>(delaySamples * 0.75f), 64, kMaxSamples - 1);

    int readL = (writePos - delaySamples + kMaxSamples) % kMaxSamples;
    int readR = (writePos - delayR + kMaxSamples) % kMaxSamples;

    float dL = bufL[readL];
    float dR = bufR[readR];

    float amt = std::clamp(feedbackMixParam, 0.0f, 1.0f);
    float fb = 0.15f + amt * 0.48f;
    float mix = amt * 0.55f;

    // Cross-feedback (subtle ping-pong stereo echo)
    bufL[writePos] = l + dR * fb;
    bufR[writePos] = r + dL * fb;
    writePos = (writePos + 1) % kMaxSamples;

    l = l * (1.0f - mix * 0.3f) + dL * mix;
    r = r * (1.0f - mix * 0.3f) + dR * mix;
  }
};

struct VoiceFilterFx {
  Biquad hpf;
  Biquad lpf;
  float lastMode = -1.0f;

  inline void process(float& l, float& r, float modeParam, float driveParam, float sampleRate) {
    int mode = (modeParam < 0.33f) ? 0 : (modeParam < 0.66f ? 1 : 2); // 0=Radio, 1=Phone, 2=Megaphone
    if (std::abs(static_cast<float>(mode) - lastMode) > 0.1f) {
      if (mode == 0) {
        hpf.setHighPass(sampleRate, 360.0f, 0.9f);
        lpf.setPeaking(sampleRate, 1800.0f, 4.5f, 1.0f);
      } else if (mode == 1) {
        hpf.setHighPass(sampleRate, 550.0f, 1.1f);
        lpf.setPeaking(sampleRate, 1300.0f, 6.0f, 1.4f);
      } else {
        hpf.setHighPass(sampleRate, 620.0f, 1.2f);
        lpf.setPeaking(sampleRate, 2200.0f, 7.5f, 1.2f);
      }
      lastMode = static_cast<float>(mode);
    }

    hpf.processStereo(l, r);
    lpf.processStereo(l, r);

    float drive = 1.5f + std::clamp(driveParam, 0.0f, 1.0f) * 5.0f;
    l = std::tanh(l * drive) / std::tanh(drive);
    r = std::tanh(r * drive) / std::tanh(drive);
  }
};

struct MasterLimiter {
  float env = 0.0f;

  inline void process(float& l, float& r, float driveDb, float ceilingDb, float sampleRate, bool enabled) {
    if (!enabled) return;
    float driveLin = dbToLinear(std::clamp(driveDb, 0.0f, 12.0f));
    float ceilLin = dbToLinear(std::clamp(ceilingDb, -6.0f, -0.1f));

    l *= driveLin;
    r *= driveLin;

    float peak = std::max(std::abs(l), std::abs(r));
    float rel = std::exp(-1.0f / (0.065f * sampleRate));
    env = (peak > env) ? peak : (rel * env + (1.0f - rel) * peak);

    float gain = (env > ceilLin) ? (ceilLin / (env + 1e-6f)) : 1.0f;
    l = std::clamp(l * gain, -ceilLin, ceilLin);
    r = std::clamp(r * gain, -ceilLin, ceilLin);
  }
};

} // namespace ssm
