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
  std::atomic<float> eqMidHz{1200.0f};
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
  std::atomic<int> inputChannelOffset{0}; // 0=in1, 1=in2, etc.
  std::atomic<bool> stereoInput{true};    // false=true Mono (single slot), true=Stereo (pair)
  std::atomic<int> sourceMode{0};         // 0=hwMic, 1=bgmDeck+loopback, 2=loopback/aux, 3=pads, 4=fx

  std::atomic<int> insertA{0};            // 0=None, 1=DeEsser, 2=Warmth, 3=Delay, 4=VoiceFX
  std::atomic<float> insertAParam1{0.5f};
  std::atomic<float> insertAParam2{0.5f};
  std::atomic<int> insertB{0};
  std::atomic<float> insertBParam1{0.5f};
  std::atomic<float> insertBParam2{0.5f};
};

struct ChannelDsp {
  Biquad hpf;
  Biquad eqLow;
  Biquad eqMid;
  Biquad eqHigh;
  NoiseGate gate;
  Compressor comp;
  DeEsser deEsser;
  VocalWarmth warmth;
  StereoDelay delay;
  VoiceFilterFx voiceFx;

  float lastHpfHz = -1.0f;
  float lastLow = -999.0f;
  float lastMidHz = -1.0f;
  float lastMid = -999.0f;
  float lastHigh = -999.0f;
  float tonePhase = 0.0f;

  std::atomic<float> peakL{0.0f};
  std::atomic<float> peakR{0.0f};
  std::atomic<float> compGrDb{0.0f};
};

class MixerEngine {
public:
  static constexpr int kChannels = 8; // 0..2:Mic/Line, 3..5:Guest/Game/App, 6:Music/BGM, 7:Soundboard

  std::array<ChannelAtomicParams, kChannels> chParams;
  std::array<ChannelDsp, kChannels> chDsp;

  std::atomic<bool> autoDuckEnabled{true};
  std::atomic<float> autoDuckDepthDb{-10.0f};
  std::atomic<float> reverbDecay{0.75f};
  std::atomic<float> fxReturnDb{-6.0f};
  std::atomic<bool> fxReturnMute{false};

  std::atomic<float> streamMasterDb{0.0f};
  std::atomic<bool> streamMasterMute{false};
  std::atomic<float> monitorMasterDb{0.0f};
  std::atomic<bool> monitorMasterMute{false};
  std::atomic<bool> masterLimiterOn{true};
  std::atomic<float> masterLimiterDriveDb{2.0f};
  std::atomic<float> masterLimiterCeilingDb{-1.0f};

  std::atomic<float> streamPeakL{0.0f};
  std::atomic<float> streamPeakR{0.0f};
  std::atomic<float> monitorPeakL{0.0f};
  std::atomic<float> monitorPeakR{0.0f};
  std::atomic<float> fxPeakL{0.0f};
  std::atomic<float> fxPeakR{0.0f};
  std::atomic<float> duckGainDb{0.0f};

  Soundboard soundboard;
  BgmPlayer bgm;

  MixerEngine() {
    // 8-channel DAW-style DM12 streaming defaults (Audio 1-2 Mono, Audio 3-6 Stereo)
    chParams[0].duckRole.store(1);      // Audio 1: triggers ducking
    chParams[0].sourceMode.store(0);    // Hardware Mic in 1
    chParams[0].inputChannelOffset.store(0);
    chParams[0].stereoInput.store(false);
    chParams[0].gateOn.store(true);
    chParams[0].compOn.store(true);
    chParams[0].hpfOn.store(true);
    chParams[0].hpfHz.store(85.0f);

    chParams[1].duckRole.store(1);      // Audio 2: Hardware Mic in 2 (Mono isolated)
    chParams[1].sourceMode.store(0);
    chParams[1].inputChannelOffset.store(1);
    chParams[1].stereoInput.store(false);
    chParams[1].mute.store(true);
    chParams[1].hpfOn.store(true);
    chParams[1].hpfHz.store(85.0f);

    chParams[2].sourceMode.store(0);    // Audio 3: Hardware Stereo 1-2
    chParams[2].inputChannelOffset.store(0);
    chParams[2].stereoInput.store(true);
    chParams[2].mute.store(true);
    chParams[2].hpfOn.store(false);

    chParams[3].sourceMode.store(2);    // Audio 4: Loopback Stereo
    chParams[3].stereoInput.store(true);
    chParams[3].hpfOn.store(true);

    chParams[4].sourceMode.store(2);    // Audio 5: Loopback Stereo
    chParams[4].stereoInput.store(true);
    chParams[4].hpfOn.store(false);

    chParams[5].sourceMode.store(2);    // Audio 6: Loopback Stereo
    chParams[5].stereoInput.store(true);
    chParams[5].hpfOn.store(false);

    chParams[6].duckRole.store(2);      // 7-8 BGM / Music (Ducked when Mic talks)
    chParams[6].sourceMode.store(1);    // Built-in BGM Deck + Loopback
    chParams[6].stereoInput.store(true);
    chParams[6].hpfOn.store(false);

    chParams[7].sourceMode.store(3);    // 9-10 Soundboard Pads
    chParams[7].stereoInput.store(true);
    chParams[7].hpfOn.store(false);
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
      revStreamInL_.assign(frames, 0.0f);
      revStreamInR_.assign(frames, 0.0f);
      revMonInL_.assign(frames, 0.0f);
      revMonInR_.assign(frames, 0.0f);
    }

    std::fill(padScratchL_.begin(), padScratchL_.begin() + frames, 0.0f);
    std::fill(padScratchR_.begin(), padScratchR_.begin() + frames, 0.0f);
    std::fill(bgmScratchL_.begin(), bgmScratchL_.begin() + frames, 0.0f);
    std::fill(bgmScratchR_.begin(), bgmScratchR_.begin() + frames, 0.0f);
    std::fill(revStreamInL_.begin(), revStreamInL_.begin() + frames, 0.0f);
    std::fill(revStreamInR_.begin(), revStreamInR_.begin() + frames, 0.0f);
    std::fill(revMonInL_.begin(), revMonInL_.begin() + frames, 0.0f);
    std::fill(revMonInR_.begin(), revMonInR_.begin() + frames, 0.0f);
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
      float midHz = std::clamp(p.eqMidHz.load(std::memory_order_relaxed), 150.0f, 3500.0f);
      float midDb = p.eqMidDb.load(std::memory_order_relaxed);
      float highDb = p.eqHighDb.load(std::memory_order_relaxed);
      if (std::abs(lowDb - d.lastLow) > 0.05f) {
        d.eqLow.setLowShelf(sampleRate_, 80.0f, lowDb);
        d.lastLow = lowDb;
      }
      if (std::abs(midDb - d.lastMid) > 0.05f || std::abs(midHz - d.lastMidHz) > 1.0f) {
        d.eqMid.setPeaking(sampleRate_, midHz, midDb, 1.0f);
        d.lastMid = midDb;
        d.lastMidHz = midHz;
      }
      if (std::abs(highDb - d.lastHigh) > 0.05f) {
        d.eqHigh.setHighShelf(sampleRate_, 12000.0f, highDb);
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
      bool stereoIn = p.stereoInput.load(std::memory_order_relaxed);
      int srcMode = p.sourceMode.load(std::memory_order_relaxed);
      int insA = p.insertA.load(std::memory_order_relaxed);
      float insAP1 = p.insertAParam1.load(std::memory_order_relaxed);
      float insAP2 = p.insertAParam2.load(std::memory_order_relaxed);
      int insB = p.insertB.load(std::memory_order_relaxed);
      float insBP1 = p.insertBParam1.load(std::memory_order_relaxed);
      float insBP2 = p.insertBParam2.load(std::memory_order_relaxed);

      auto runInsert = [&](int kind, float p1, float p2, float& sL, float& sR) {
        if (kind == 1) d.deEsser.process(sL, sR, p1, p2, sampleRate_);
        else if (kind == 2) d.warmth.process(sL, sR, p1, p2, sampleRate_);
        else if (kind == 3) d.delay.process(sL, sR, p1, p2, sampleRate_);
        else if (kind == 4) d.voiceFx.process(sL, sR, p1, p2, sampleRate_);
      };

      auto readSlot = [&](const float* interleaved, int numCh, float& outL, float& outR) {
        if (!interleaved || numCh <= 0) return;
        int chL = std::clamp(inOffset, 0, numCh - 1);
        outL = interleaved[chL];
        if (stereoIn && chL + 1 < numCh) {
          outR = interleaved[chL + 1];
        } else {
          outR = outL;
        }
      };

      float maxL = 0.0f;
      float maxR = 0.0f;
      float toneFreq = 220.0f + c * 55.0f;

      for (size_t i = 0; i < frames; ++i) {
        float l = 0.0f;
        float r = 0.0f;

        if (srcMode == 3) {
          l = padScratchL_[i];
          r = padScratchR_[i];
        } else if (srcMode == 1) {
          l = bgmScratchL_[i];
          r = bgmScratchR_[i];
          if (musicInInterleaved && musicInChannels > 0) {
            float mL = 0.0f, mR = 0.0f;
            readSlot(musicInInterleaved + i * musicInChannels, musicInChannels, mL, mR);
            l += mL;
            r += mR;
          }
        } else if (srcMode == 2) {
          if (musicInInterleaved && musicInChannels > 0) {
            readSlot(musicInInterleaved + i * musicInChannels, musicInChannels, l, r);
          } else if (hwInInterleaved && inOffset > 0 && inOffset < hwInChannels) {
            readSlot(hwInInterleaved + i * hwInChannels, hwInChannels, l, r);
          }
        } else if (srcMode == 0 && hwInInterleaved && hwInChannels > 0) {
          if (inOffset < hwInChannels) {
            readSlot(hwInInterleaved + i * hwInChannels, hwInChannels, l, r);
          }
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
        runInsert(insA, insAP1, insAP2, l, r);
        runInsert(insB, insBP1, insBP2, l, r);

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
          if (toStream) {
            revStreamInL_[i] += postL * revSend;
            revStreamInR_[i] += postR * revSend;
          }
          if (toMon) {
            revMonInL_[i] += postL * revSend;
            revMonInR_[i] += postR * revSend;
          }
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

    // Global Aux 1 Stereo Reverb Return (isolated per bus so OBS=OFF never bleeds reverb)
    {
      float faderLin = fxReturnMute.load(std::memory_order_relaxed)
                           ? 0.0f
                           : dbToLinear(fxReturnDb.load(std::memory_order_relaxed));
      float decay = reverbDecay.load(std::memory_order_relaxed);
      float maxL = 0.0f;
      float maxR = 0.0f;
      for (size_t i = 0; i < frames; ++i) {
        float srl = 0.0f, srr = 0.0f;
        revStream_.process(revStreamInL_[i], revStreamInR_[i], srl, srr, decay);
        srl *= faderLin;
        srr *= faderLin;
        outStreamL[i] += srl;
        outStreamR[i] += srr;

        float mrl = 0.0f, mrr = 0.0f;
        revMon_.process(revMonInL_[i], revMonInR_[i], mrl, mrr, decay);
        mrl *= faderLin;
        mrr *= faderLin;
        outMonL[i] += mrl;
        outMonR[i] += mrr;

        maxL = std::max(maxL, std::max(std::abs(srl), std::abs(mrl)));
        maxR = std::max(maxR, std::max(std::abs(srr), std::abs(mrr)));
      }
      fxPeakL.store(std::max(maxL, fxPeakL.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
      fxPeakR.store(std::max(maxR, fxPeakR.load(std::memory_order_relaxed) * 0.85f), std::memory_order_relaxed);
    }

    // Master Buses with Broadcast Limiter + Soft Safety Limiter (prevents OBS/TTLS clipping)
    float sGain = streamMasterMute.load(std::memory_order_relaxed)
                      ? 0.0f
                      : dbToLinear(streamMasterDb.load(std::memory_order_relaxed));
    float mGain = monitorMasterMute.load(std::memory_order_relaxed)
                      ? 0.0f
                      : dbToLinear(monitorMasterDb.load(std::memory_order_relaxed));
    bool limOn = masterLimiterOn.load(std::memory_order_relaxed) && !streamMasterMute.load(std::memory_order_relaxed);
    float limDrive = masterLimiterDriveDb.load(std::memory_order_relaxed);
    float limCeil = masterLimiterCeilingDb.load(std::memory_order_relaxed);

    float sMaxL = 0.0f, sMaxR = 0.0f, mMaxL = 0.0f, mMaxR = 0.0f;
    for (size_t i = 0; i < frames; ++i) {
      float sl = outStreamL[i] * sGain;
      float sr = outStreamR[i] * sGain;
      streamLimiter_.process(sl, sr, limDrive, limCeil, sampleRate_, limOn);
      sl = std::tanh(sl);
      sr = std::tanh(sr);
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
  SimpleStereoReverb revStream_;
  SimpleStereoReverb revMon_;
  MasterLimiter streamLimiter_;
  std::vector<float> padScratchL_, padScratchR_, bgmScratchL_, bgmScratchR_;
  std::vector<float> revStreamInL_, revStreamInR_, revMonInL_, revMonInR_;
};

} // namespace ssm
