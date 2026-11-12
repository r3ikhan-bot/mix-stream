#pragma once

#include "MixerEngine.hpp"
#include <string>
#include <vector>

namespace ssm {

struct AudioDeviceInfo {
  std::string id;
  std::string name;
  int inputChannels = 0;
  int outputChannels = 0;
  bool isDefaultInput = false;
  bool isDefaultOutput = false;
  double sampleRate = 48000.0;
  std::vector<int> sampleRates;
  std::string driver;
};

class AudioBackend {
public:
  virtual ~AudioBackend() = default;
  virtual std::vector<AudioDeviceInfo> listDevices() = 0;
  virtual bool start(MixerEngine& engine,
                     const std::string& inputDevId,
                     const std::string& musicInputDevId,
                     const std::string& monitorOutDevId,
                     const std::string& streamOutDevId,
                     int bufferSize,
                     int sampleRate = 0) = 0;
  virtual bool startMulti(MixerEngine& engine,
                          const std::vector<std::string>& inputDevIds,
                          const std::string& monitorOutDevId,
                          const std::string& streamOutDevId,
                          int bufferSize,
                          int sampleRate = 0) {
    std::string in0 = inputDevIds.size() > 0 ? inputDevIds[0] : "";
    std::string in1 = inputDevIds.size() > 1 ? inputDevIds[1] : "";
    return start(engine, in0, in1, monitorOutDevId, streamOutDevId, bufferSize, sampleRate);
  }
  virtual void stop() = 0;
  virtual bool isRunning() const = 0;
  virtual std::string statusText() const = 0;
};

AudioBackend* createPlatformAudioBackend();

} // namespace ssm
