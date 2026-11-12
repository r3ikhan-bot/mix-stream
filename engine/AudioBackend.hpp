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
};

class AudioBackend {
public:
  virtual ~AudioBackend() = default;
  virtual std::vector<AudioDeviceInfo> listDevices() = 0;
  virtual bool start(MixerEngine& engine,
                     const std::string& inputDevId,
                     const std::string& monitorOutDevId,
                     const std::string& streamOutDevId,
                     int bufferSize) = 0;
  virtual void stop() = 0;
  virtual bool isRunning() const = 0;
  virtual std::string statusText() const = 0;
};

AudioBackend* createPlatformAudioBackend();

} // namespace ssm
