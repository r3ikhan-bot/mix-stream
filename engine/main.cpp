#include "AudioBackend.hpp"
#include "MixerEngine.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char ch : s) {
    if (ch == '"') out += "\\\"";
    else if (ch == '\\') out += "\\\\";
    else if (ch == '\n') out += "\\n";
    else if (ch == '\r') out += "\\r";
    else out += ch;
  }
  return out;
}

std::vector<std::string> splitTabs(const std::string& line) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (start <= line.size()) {
    size_t pos = line.find('\t', start);
    if (pos == std::string::npos) {
      parts.push_back(line.substr(start));
      break;
    }
    parts.push_back(line.substr(start, pos - start));
    start = pos + 1;
  }
  return parts;
}

} // namespace

int main() {
  std::ios::sync_with_stdio(false);
  std::setvbuf(stdout, nullptr, _IONBF, 0);

  ssm::MixerEngine engine;
  std::unique_ptr<ssm::AudioBackend> backend(ssm::createPlatformAudioBackend());
  std::mutex ioMutex;
  std::atomic<bool> quitFlag{false};

  auto emitLine = [&](const std::string& line) {
    std::lock_guard<std::mutex> lock(ioMutex);
    std::cout << line << "\n" << std::flush;
  };

  auto emitDevices = [&]() {
    auto devs = backend->listDevices();
    std::ostringstream os;
    os << "DEVICES [";
    for (size_t i = 0; i < devs.size(); ++i) {
      if (i > 0) os << ",";
      const auto& d = devs[i];
      os << "{\"id\":\"" << jsonEscape(d.id)
         << "\",\"name\":\"" << jsonEscape(d.name)
         << "\",\"in\":" << d.inputChannels
         << ",\"out\":" << d.outputChannels
         << ",\"defIn\":" << (d.isDefaultInput ? "true" : "false")
         << ",\"defOut\":" << (d.isDefaultOutput ? "true" : "false")
         << ",\"sampleRate\":" << static_cast<int>(d.sampleRate)
         << ",\"driver\":\"" << jsonEscape(d.driver) << "\""
         << ",\"sampleRates\":[";
      for (size_t r = 0; r < d.sampleRates.size(); ++r) {
        if (r > 0) os << ",";
        os << d.sampleRates[r];
      }
      os << "]}";
    }
    os << "]";
    emitLine(os.str());
  };

  auto emitStatus = [&]() {
    std::ostringstream os;
    os << "STATUS {\"running\":" << (backend->isRunning() ? "true" : "false")
       << ",\"sampleRate\":" << static_cast<int>(engine.sampleRate())
       << ",\"text\":\"" << jsonEscape(backend->statusText()) << "\"}";
    emitLine(os.str());
  };

  // Start default audio backend immediately
  backend->start(engine, "default", "none", "default", "none", 256);

  emitLine("READY StudioStreamEngine");
  emitDevices();
  emitStatus();

  // Meter thread (~25 Hz)
  std::thread meterThread([&]() {
    while (!quitFlag.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(40));
      if (quitFlag.load()) break;

      std::ostringstream os;
      os << "METERS {\"ch\":[";
      for (int c = 0; c < ssm::MixerEngine::kChannels; ++c) {
        if (c > 0) os << ",";
        float pL = ssm::linearToDb(engine.chDsp[c].peakL.load(std::memory_order_relaxed));
        float pR = ssm::linearToDb(engine.chDsp[c].peakR.load(std::memory_order_relaxed));
        float gr = engine.chDsp[c].compGrDb.load(std::memory_order_relaxed);
        os << "[" << static_cast<int>(pL * 10) / 10.0f << ","
           << static_cast<int>(pR * 10) / 10.0f << ","
           << static_cast<int>(gr * 10) / 10.0f << "]";
      }
      float sL = ssm::linearToDb(engine.streamPeakL.load(std::memory_order_relaxed));
      float sR = ssm::linearToDb(engine.streamPeakR.load(std::memory_order_relaxed));
      float mL = ssm::linearToDb(engine.monitorPeakL.load(std::memory_order_relaxed));
      float mR = ssm::linearToDb(engine.monitorPeakR.load(std::memory_order_relaxed));
      float duck = engine.duckGainDb.load(std::memory_order_relaxed);
      os << "],\"stream\":[" << static_cast<int>(sL * 10) / 10.0f << "," << static_cast<int>(sR * 10) / 10.0f
         << "],\"monitor\":[" << static_cast<int>(mL * 10) / 10.0f << "," << static_cast<int>(mR * 10) / 10.0f
         << "],\"duckDb\":" << static_cast<int>(duck * 10) / 10.0f << "}";
      emitLine(os.str());
    }
  });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    auto parts = splitTabs(line);
    const std::string& cmd = parts[0];

    if (cmd == "QUIT") {
      break;
    } else if (cmd == "LIST_DEVICES") {
      emitDevices();
    } else if (cmd == "START_MULTI" && parts.size() >= 6) {
      std::vector<std::string> inIds;
      std::stringstream iss(parts[1]);
      std::string tok;
      while (std::getline(iss, tok, ',')) {
        if (!tok.empty() && tok != "none") inIds.push_back(tok);
      }
      int buf = 256;
      int sr = 0;
      try { buf = std::stoi(parts[4]); } catch (...) {}
      try { sr = std::stoi(parts[5]); } catch (...) {}
      backend->startMulti(engine, inIds, parts[2], parts[3], buf, sr);
      emitStatus();
    } else if (cmd == "START" && parts.size() >= 6) {
      int buf = 256;
      int sr = 0;
      try { buf = std::stoi(parts[5]); } catch (...) {}
      if (parts.size() >= 7) {
        try { sr = std::stoi(parts[6]); } catch (...) {}
      }
      backend->start(engine, parts[1], parts[2], parts[3], parts[4], buf, sr);
      emitStatus();
    } else if (cmd == "START" && parts.size() >= 5) {
      int buf = 256;
      try { buf = std::stoi(parts[4]); } catch (...) {}
      backend->start(engine, parts[1], "none", parts[2], parts[3], buf);
      emitStatus();
    } else if (cmd == "STOP") {
      backend->stop();
      emitStatus();
    } else if (cmd == "CH" && parts.size() >= 4) {
      int idx = std::stoi(parts[1]);
      if (idx < 0 || idx >= ssm::MixerEngine::kChannels) continue;
      const std::string& key = parts[2];
      float val = std::stof(parts[3]);
      bool bval = (val > 0.5f);
      auto& p = engine.chParams[idx];

      if (key == "trimDb") p.trimDb.store(val, std::memory_order_relaxed);
      else if (key == "phaseInvert") p.phaseInvert.store(bval, std::memory_order_relaxed);
      else if (key == "hpfOn") p.hpfOn.store(bval, std::memory_order_relaxed);
      else if (key == "hpfHz") p.hpfHz.store(val, std::memory_order_relaxed);
      else if (key == "gateOn") p.gateOn.store(bval, std::memory_order_relaxed);
      else if (key == "gateThreshDb") p.gateThreshDb.store(val, std::memory_order_relaxed);
      else if (key == "eqOn") p.eqOn.store(bval, std::memory_order_relaxed);
      else if (key == "eqLowDb") p.eqLowDb.store(val, std::memory_order_relaxed);
      else if (key == "eqMidHz") p.eqMidHz.store(val, std::memory_order_relaxed);
      else if (key == "eqMidDb") p.eqMidDb.store(val, std::memory_order_relaxed);
      else if (key == "eqHighDb") p.eqHighDb.store(val, std::memory_order_relaxed);
      else if (key == "compOn") p.compOn.store(bval, std::memory_order_relaxed);
      else if (key == "compThreshDb") p.compThreshDb.store(val, std::memory_order_relaxed);
      else if (key == "compRatio") p.compRatio.store(val, std::memory_order_relaxed);
      else if (key == "compMakeupDb") p.compMakeupDb.store(val, std::memory_order_relaxed);
      else if (key == "reverbSend") p.reverbSend.store(val, std::memory_order_relaxed);
      else if (key == "pan") p.pan.store(val, std::memory_order_relaxed);
      else if (key == "faderDb") p.faderDb.store(val, std::memory_order_relaxed);
      else if (key == "mute") p.mute.store(bval, std::memory_order_relaxed);
      else if (key == "solo") p.solo.store(bval, std::memory_order_relaxed);
      else if (key == "routeStream") p.routeStream.store(bval, std::memory_order_relaxed);
      else if (key == "routeMonitor") p.routeMonitor.store(bval, std::memory_order_relaxed);
      else if (key == "duckRole") p.duckRole.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "testTone") p.testTone.store(bval, std::memory_order_relaxed);
      else if (key == "inputChannelOffset") p.inputChannelOffset.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "stereoInput") p.stereoInput.store(bval, std::memory_order_relaxed);
      else if (key == "sourceSlot") p.sourceSlot.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "sourceMode") p.sourceMode.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "insertA") p.insertA.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "insertAParam1") p.insertAParam1.store(val, std::memory_order_relaxed);
      else if (key == "insertAParam2") p.insertAParam2.store(val, std::memory_order_relaxed);
      else if (key == "insertB") p.insertB.store(static_cast<int>(val), std::memory_order_relaxed);
      else if (key == "insertBParam1") p.insertBParam1.store(val, std::memory_order_relaxed);
      else if (key == "insertBParam2") p.insertBParam2.store(val, std::memory_order_relaxed);
    } else if (cmd == "GLOBAL" && parts.size() >= 3) {
      const std::string& key = parts[1];
      float val = std::stof(parts[2]);
      bool bval = (val > 0.5f);
      if (key == "autoDuckEnabled") engine.autoDuckEnabled.store(bval, std::memory_order_relaxed);
      else if (key == "autoDuckDepthDb") engine.autoDuckDepthDb.store(val, std::memory_order_relaxed);
      else if (key == "reverbDecay") engine.reverbDecay.store(val, std::memory_order_relaxed);
      else if (key == "fxReturnDb") engine.fxReturnDb.store(val, std::memory_order_relaxed);
      else if (key == "fxReturnMute") engine.fxReturnMute.store(bval, std::memory_order_relaxed);
      else if (key == "streamMasterDb") engine.streamMasterDb.store(val, std::memory_order_relaxed);
      else if (key == "streamMasterMute") engine.streamMasterMute.store(bval, std::memory_order_relaxed);
      else if (key == "monitorMasterDb") engine.monitorMasterDb.store(val, std::memory_order_relaxed);
      else if (key == "monitorMasterMute") engine.monitorMasterMute.store(bval, std::memory_order_relaxed);
      else if (key == "masterLimiterOn") engine.masterLimiterOn.store(bval, std::memory_order_relaxed);
      else if (key == "masterLimiterDriveDb") engine.masterLimiterDriveDb.store(val, std::memory_order_relaxed);
      else if (key == "masterLimiterCeilingDb") engine.masterLimiterCeilingDb.store(val, std::memory_order_relaxed);
      else if (key == "bgmPlaying") engine.bgm.playing.store(bval, std::memory_order_relaxed);
      else if (key == "bgmLoop") engine.bgm.loop.store(bval, std::memory_order_relaxed);
    } else if (cmd == "BGM_LOAD" && parts.size() >= 2) {
      bool ok = engine.bgm.loadWav(parts[1], static_cast<uint32_t>(engine.sampleRate()));
      emitLine(std::string("BGM_LOADED ") + (ok ? "1" : "0"));
    } else if (cmd == "BGM_RESTART") {
      engine.bgm.restart();
    } else if (cmd == "PAD_TRIGGER" && parts.size() >= 3) {
      int idx = std::stoi(parts[1]);
      float gain = std::stof(parts[2]);
      engine.soundboard.trigger(idx, gain);
    } else if (cmd == "PAD_STOP_ALL") {
      engine.soundboard.stopAll();
    } else if (cmd == "PAD_LOAD" && parts.size() >= 4) {
      int idx = std::stoi(parts[1]);
      bool ok = engine.soundboard.loadWav(idx, parts[2], parts[3]);
      emitLine(std::string("PAD_LOADED ") + (ok ? "1" : "0"));
    }
  }

  quitFlag.store(true);
  if (meterThread.joinable()) meterThread.join();
  backend->stop();
  return 0;
}
