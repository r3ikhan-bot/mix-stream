#pragma once

#include "DspMath.hpp"
#include "Soundboard.hpp"
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

namespace ssm {

struct ChannelAtomicParams {
  std::atomic<float> trimDb{0.0f};
  std::atomic<bool> phaseInvert{false};

  std::atomic<bool> hpfOn{true};
  std::atomic<float> hpfHz{80.0f};

  std::atomic<bool> gateOn{false};
  std::atomic<float> gateThreshDb{-48.0f};

  std::atomic<bool> eqOn{true};
  std::atomic<float> eqLowDb{0.0f};
  std::atomic<float> eqMidDb{0.0f};
  std::atomic<float> eqHighDb{0.0f};

  std::atomic<bool> compOn{false};
  std::atomic<float> compThreshDb{-18.0f};
  std::atomic<float> compRatio{3.0f};
  std::atomic<float> compMakeupDb{2.0f};

  std::atomic<float> reverbSend{0.0f};
  std::atomic<float> pan{0.0f};
  std::atomic<float> faderDb{0.0f};

  std::atomic<bool> mute{false};
  std::atomic<bool> solo{false};
  std::atomic<bool> routeStream{true};
  std::atomic<bool> routeMonitor{true};
  std::atomic<int> duckRole{0}; // 0=none, 1=trigger(mic), 2=target(music)
  std::atomic<bool> testTone{false};
  std::atomic<int> inputChannelOffset{0}; // 0=ch1-2, 2=ch3-4, etc.
  std::atomic<int> sourceMode{0};         // 0=hwMic, 1=bgmDeck+loopback, 2=loopback/aux, 3=pads, 4=fx
};

struct ChannelDsp {
  Biquad hpf;
  Biquad eqLow;
  Biquad eqMid;
  Biquad eqHigh;
  NoiseGate gate;
  Compressor comp;

  float lastHpfHz = -1.0f;
  float lastLow = -999.0f;
  float lastMid = -999.0f;
  float lastHigh = -999.0f;
  float tonePhase = 0.0f;

  std::atomic<float> peakL{0.0f};
  std::atomic<float> peakR{0.0f};
  std::atomic<float> compGrDb{0.0f};
};

class MixerEngine {
public:
  static constexpr int kChannels = 6; // 0:Mic, 1:Music, 2:Game/TTLS, 3:Guest, 4:Pads, 5:FX

  std::array<ChannelAtomicParams, kChannels> chParams;
  std::array<ChannelDsp, kChannels> chDsp;

  std::atomic<bool> autoDuckEnabled{true};
  std::atomic<float> autoDuckDepthDb{-10.0f};
  std::atomic<float> reverbDecay{0.75f};

  std::atomic<float> streamMasterDb{0.0f};
  std::atomic<bool> streamMasterMute{false};
  std::atomic<float> monitorMasterDb{0.0f};
  std::atomic<bool> monitorMasterMute{false};

  std::atomic<float> streamPeakL{0.0f};
  std::atomic<float> streamPeakR{0.0f};
  std::atomic<float> monitorPeakL{0.0f};
  std::atomic<float> monitorPeakR{0.0f};
  std::atomic<float> duckGainDb{0.0f};

  Soundboard soundboard;
  BgmPlayer bgm;

  MixerEngine() {
    // Channel defaults tailored for Live Streaming / OBS / TTLS
    chParams[0].duckRole.store(1);      // Mic triggers ducking
    chParams[0].sourceMode.store(0);    // Hardware Mic input
    chParams[0].gateOn.store(true);
    chParams[0].compOn.store(true);
    chParams[0].hpfOn.store(true);
    chParams[0].hpfHz.store(85.0f);

    chParams[1].duckRole.store(2);      // Music gets ducked when Mic talks
    chParams[1].sourceMode.store(1);    // Built-in BGM Deck + Loopback input
    chParams[1].hpfOn.store(false);
    chParams[2].sourceMode.store(2);    // Loopback / Aux capture
    chParams[2].hpfOn.store(false);     // Game / Browser
    chParams[3].sourceMode.store(2);    // Loopback / Aux capture
    chParams[3].hpfOn.store(true);      // Guest / Discord
    chParams[4].sourceMode.store(3);    // Soundboard Pads
    chParams[4].hpfOn.store(false);
    chParams[5].sourceMode.store(4);    // FX Return
    chParams[5].hpfOn.store(true);
  }

  void setSampleRate(float sr) {
    sampleRate_ = (sr > 8000.0f) ? sr : 48000.0f;
    soundboard.initDefaultSynthSamples(sampleRate_);
  }

  float sampleRate() const { return sampleRate_; }

  /**
   * Processes one audio block from hardware inputs (Mic + optional Loopback/BGM input)
   * and built-in BGM/Soundboard players into separate Stream (OBS/TTLS) and Monitor stereo buffers.
   */
  void processBlock(const float* hwInInterleaved, int hwInChannels,
                    const float* musicInInterleaved, int musicInChannels,
                    size_t frames,
                    float* outStreamL, float* outStreamR,
                    float* outMonL, float* outMonR) {
    if (frames == 0) return;

    if (padScratchL_.size() < frames) {
      padScratchL_.assign(frames, 0.0f);
      padScratchR_.assign(frames, 0.0f);
      bgmScratchL_.assign(frames, 0.0f);
      bgmScratchR_.assign(frames, 0.0f);
      revInL_.assign(frames, 0.0f);
      revInR_.assign(frames, 0.0f);
    }

    std::fill(padScratchL_.begin(), padScratchL_.begin() + frames, 0.0f);
    std::fill(padScratchR_.begin(), padScratchR_.begin() + frames, 0.0f);
    std::fill(bgmScratchL_.begin(), bgmScratchL_.begin() + frames, 0.0f);
    std::fill(bgmScratchR_.begin(), bgmScratchR_.begin() + frames, 0.0f);
    std::fill(revInL_.begin(), revInL_.begin() + frames, 0.0f);
    std::fill(revInR_.begin(), revInR_.begin() + frames, 0.0f);
    std::fill(outStreamL, outStreamL + frames, 0.0f);
    std::fill(outStreamR, outStreamR + frames, 0.0f);
    std::fill(outMonL, outMonL + frames, 0.0f);
    std::fill(outMonR, outMonR + frames, 0.0f);

    soundboard.mixStereo(padScratchL_.data(), padScratchR_.data(), frames);
    bgm.renderStereo(bgmScratchL_.data(), bgmScratchR_.data(), frames);

    bool anySolo = false;
    for (int c = 0; c < kChannels; ++c) {
      if (chParams[c].solo.load(std::memory_order_relaxed)) {
        anySolo = true;
        break;
      }
    }

    // Check ducking trigger activity from channel 0 (or any duckRole==1 channel)
    float triggerLevel = 0.0f;

    for (int c = 0; c < kChannels; ++c) {
      auto& p = chParams[c];
      auto& d = chDsp[c];

      float hpfHz = p.hpfHz.load(std::memory_order_relaxed);
      if (std::abs(hpfHz - d.lastHpfHz) > 0.5f) {
        d.hpf.setHighPass(sampleRate_, hpfHz);
        d.lastHpfHz = hpfHz;
      }

      float lowDb = p.eqLowDb.load(std::memory_order_relaxed);
      float midDb = p.eqMidDb.load(std::memory_order_relaxed);
      float highDb = p.eqHighDb.load(std::memory_order_relaxed);
      if (std::abs(lowDb - d.lastLow) > 0.05f) {
        d.eqLow.setLowShelf(sampleRate_, 120.0f, lowDb);
        d.lastLow = lowDb;
      }
      if (std::abs(midDb - d.lastMid) > 0.05f) {
        d.eqMid.setPeaking(sampleRate_, 1200.0f, midDb, 1.0f);
        d.lastMid = midDb;
      }
      if (std::abs(highDb - d.lastHigh) > 0.05f) {
        d.eqHigh.setHighShelf(sampleRate_, 6500.0f, highDb);
        d.lastHigh = highDb;
      }

      float trim = dbToLinear(p.trimDb.load(std::memory_order_relaxed));
      float phase = p.phaseInvert.load(std::memory_order_relaxed) ? -1.0f : 1.0f;
      bool hpfOn = p.hpfOn.load(std::memory_order_relaxed);
      bool eqOn = p.eqOn.load(std::memory_order_relaxed);
      bool gateOn = p.gateOn.load(std::memory_order_relaxed);
      float gateThresh = p.gateThreshDb.load(std::memory_order_relaxed);
      bool compOn = p.compOn.load(std::memory_order_relaxed);
      float compThresh = p.compThreshDb.load(std::memory_order_relaxed);
      float compRatio = p.compRatio.load(std::memory_order_relaxed);
      float compMakeup = p.compMakeupDb.load(std::memory_order_relaxed);

      float faderLin = dbToLinear(p.faderDb.load(std::memory_order_relaxed));
      float pan = std::clamp(p.pan.load(std::memory_order_relaxed), -1.0f, 1.0f);
      float panL = std::cos((pan + 1.0f) * 0.25f * kPi);
      float panR = std::sin((pan + 1.0f) * 0.25f * kPi);

      bool muted = p.mute.load(std::memory_order_relaxed);
      bool soloed = p.solo.load(std::memory_order_relaxed);
      bool audible = !muted && (!anySolo || soloed);
      bool toStream = audible && p.routeStream.load(std::memory_order_relaxed);
      bool toMon = audible && p.routeMonitor.load(std::memory_order_relaxed);
      float revSend = p.reverbSend.load(std::memory_order_relaxed);
      int duckRole = p.duckRole.load(std::memory_order_relaxed);
      bool tone = p.testTone.load(std::memory_order_relaxed);
      int inOffset = p.inputChannelOffset.load(std::memory_order_relaxed);
      int srcMode = p.sourceMode.load(std::memory_order_relaxed);

      float maxL = 0.0f;
      float maxR = 0.0f;
      float toneFreq = 220.0f + c * 55.0f;

      // Skip channel 5 (FX Return) here; it mixes reverb after channel loop
      if (c == 5) continue;

      for (size_t i = 0; i < frames; ++i) {
        float l = 0.0f;
        float r = 0.0f;

        if (srcMode == 3 || c == 4) {
          l = padScratchL_[i];
          r = padScratchR_[i];
        } else if (srcMode == 1) {
          l = bgmScratchL_[i];
          r = bgmScratchR_[i];
          if (musicInInterleaved && musicInChannels > 0) {
            int chL = std::min(inOffset, musicInChannels - 1);
            int chR = (inOffset + 1 < musicInChannels) ? (inOffset + 1) : chL;
            l += musicInInterleaved[i * musicInChannels + chL];
            r += musicInInterleaved[i * musicInChannels + chR];
          }
        } else if (srcMode == 2) {
          if (musicInInterleaved && musicInChannels > 0) {
            int chL = std::min(inOffset, musicInChannels - 1);
            int chR = (inOffset + 1 < musicInChannels) ? (inOffset + 1) : chL;
            l = musicInInterleaved[i * musicInChannels + chL];
            r = musicInInterleaved[i * musicInChannels + chR];
          } else if (hwInInterleaved && inOffset > 0 && inOffset < hwInChannels) {
            int chL = inOffset;
            int chR = (inOffset + 1 < hwInChannels) ? (inOffset + 1) : chL;
            l = hwInInterleaved[i * hwInChannels + chL];
            r = hwInInterleaved[i * hwInChannels + chR];
          }
        } else if (hwInInterleaved && hwInChannels > 0) {
          int chL = std::min(inOffset, hwInChannels - 1);
          int chR = (inOffset + 1 < hwInChannels) ? (inOffset + 1) : chL;
          l = hwInInterleaved[i * hwInChannels + chL];
          r = hwInInterleaved[i * hwInChannels + chR];
        }

        if (tone) {
          float s = std::sin(d.tonePhase) * 0.14f;
          d.tonePhase += 2.0f * kPi * toneFreq / sampleRate_;
          if (d.tonePhase > 2.0f * kPi) d.tonePhase -= 2.0f * kPi;
          l += s;
          r += s;
        }

        l *= trim * phase;
        r *= trim * phase;

        if (hpfOn) d.hpf.processStereo(l, r);
        d.gate.process(l, r, gateThresh, sampleRate_, gateOn);
        if (eqOn) {
          d.eqLow.processStereo(l, r);
          d.eqMid.processStereo(l, r);
          d.eqHigh.processStereo(l, r);
        }
        d.comp.process(l, r, compThresh, compRatio, compMakeup, sampleRate_, compOn);

        if (duckRole == 1 && audible) {
          triggerLevel = std::max(triggerLevel, std::max(std::abs(l), std::abs(r)));
        }

        float duckMult = 1.0f;
        if (duckRole == 2 && autoDuckEnabled.load(std::memory_order_relaxed)) {
          duckMult = currentDuckLinear_;
        }

        float postL = l * faderLin * panL * duckMult * 1.414f;
        float postR = r * faderLin * panR * duckMult * 1.414f;

        maxL = std::max(maxL, std::abs(postL));
        maxR = std::max(maxR, std::abs(postR));

        if (audible && revSend > 0.001f) {
          revInL_[i] += postL * revSend;
          revInR_[i] += postR * revSend;
        }

        if (toStream) {
          outStreamL[i] += postL;
          outStreamR[i] += postR;
        }
        if (toMon) {
          outMonL[i] += postL;
          outMonR[i] += postR;
        }
      }

      // Smoothly update auto-ducking envelope after trigger channel (c==0)
      if (duckRole == 1) {
        bool talking = (triggerLevel > dbToLinear(-34.0f));
        float targetDuck = (talking && autoDuckEnabled.load(std::memory_order_relaxed))
                               ? dbToLinear(autoDuckDepthDb.load(std::memory_order_relaxed))
                               : 1.0f;
        float coeff = (targetDuck < currentDuckLinear_) ? 0.18f : 0.03f;
        currentDuckLinear_ = currentDuckLinear_ * (1.0f - coeff) + targetDuck * coeff;
        duckGainDb.store(linearToDb(currentDuckLinear_), std::memory_order_relaxed);
      }

      float prevL = d.peakL.load(std::memory_order_relaxed) * 0.85f;
      float prevR = d.peakR.load(std::memory_order_relaxed) * 0.85f;
      d.peakL.store(std::max(maxL, prevL), std::memory_order_relaxed);
      d.peakR.store(std::max(maxR, prevR), std::memory_order_relaxed);
      d.compGrDb.store(d.comp.gainReductionDb, std::memory_order_relaxed);
    }

    // Channel 5: Reverb FX Return
    {
      auto& fp = chParams[5];
      auto& fd = chDsp[5];
      float faderLin = dbToLinear(fp.faderDb.load(std::memory_order_relaxed));
      bool muted = fp.mute.load(std::memory_order_relaxed);
      bool soloed = fp.solo.load(std::memory_order_relaxed);
      bool audible = !muted && (!anySolo || soloed);
      bool toStream = audible && fp.routeStream.load(std::memory_order_relaxed);
      bool toMon = audible && fp.routeMonitor.load(std::memory_order_relaxed);
      float decay = reverbDecay.load(std::memory_order_relaxed);

      float maxL = 0.0f;
      float maxR = 0.0f;
      for (size_t i = 0; i < frames; ++i) {
        float rl = 0.0f, rr = 0.0f;
        reverb_.process(revInL_[i], revInR_[i], rl, rr, decay);
        rl *= faderLin;
        rr *= faderLin;
        maxL = std::max(maxL, std::abs(rl));
        maxR = std::max(maxR, std::abs(rr));
        if (toStream) {
          outStreamL[i] += rl;
          outStreamR[i] += rr;
        }
        if (toMon) {
          outMonL[i] += rl;
          outMonR[i] += rr;
        }
      }
      fd.peakL.store(std::max(maxL, fd.peakL.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
      fd.peakR.store(std::max(maxR, fd.peakR.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
    }

    // Master Buses with Soft Safety Limiter (prevents OBS/TTLS clipping)
    float sGain = streamMasterMute.load(std::memory_order_relaxed)
                      ? 0.0f
                      : dbToLinear(streamMasterDb.load(std::memory_order_relaxed));
    float mGain = monitorMasterMute.load(std::memory_order_relaxed)
                      ? 0.0f
                      : dbToLinear(monitorMasterDb.load(std::memory_order_relaxed));

    float sMaxL = 0.0f, sMaxR = 0.0f, mMaxL = 0.0f, mMaxR = 0.0f;
    for (size_t i = 0; i < frames; ++i) {
      float sl = std::tanh(outStreamL[i] * sGain);
      float sr = std::tanh(outStreamR[i] * sGain);
      outStreamL[i] = sl;
      outStreamR[i] = sr;
      sMaxL = std::max(sMaxL, std::abs(sl));
      sMaxR = std::max(sMaxR, std::abs(sr));

      float ml = std::tanh(outMonL[i] * mGain);
      float mr = std::tanh(outMonR[i] * mGain);
      outMonL[i] = ml;
      outMonR[i] = mr;
      mMaxL = std::max(mMaxL, std::abs(ml));
      mMaxR = std::max(mMaxR, std::abs(mr));
    }

    streamPeakL.store(std::max(sMaxL, streamPeakL.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
    streamPeakR.store(std::max(sMaxR, streamPeakR.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
    monitorPeakL.store(std::max(mMaxL, monitorPeakL.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
    monitorPeakR.store(std::max(mMaxR, monitorPeakR.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
  }

private:
  float sampleRate_ = 48000.0f;
  float currentDuckLinear_ = 1.0f;
  SimpleStereoReverb reverb_;
  std::vector<float> padScratchL_, padScratchR_, bgmScratchL_, bgmScratchR_, revInL_, revInR_;
};

} // namespace ssm
