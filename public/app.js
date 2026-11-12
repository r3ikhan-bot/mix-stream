const app = {
  state: null,
  devices: [],
  audioStatus: { running: false, sampleRate: 48000, text: 'Connecting...' },
  lanUrls: [],
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 800,
  uploadPadIdx: 0,
  meterBus: 'stream', // 'stream' | 'monitor'
};

const dom = {
  wsDot: document.getElementById('ws-dot'),
  audioSetupBtn: document.getElementById('audio-setup-btn'),
  audioStatusLabel: document.getElementById('audio-status-label'),
  sceneBar: document.getElementById('scene-bar'),
  autoDuckBtn: document.getElementById('auto-duck-btn'),
  duckDbBadge: document.getElementById('duck-db-badge'),
  togglePadsBtn: document.getElementById('toggle-pads-btn'),
  toggleFatBtn: document.getElementById('toggle-fat-btn'),
  remoteInfoBtn: document.getElementById('remote-info-btn'),
  consoleRack: document.getElementById('console-rack'),
  masterRack: document.getElementById('master-rack'),
  fatPanel: document.getElementById('fat-panel'),
  fatChannelName: document.getElementById('fat-channel-name'),
  fatBody: document.getElementById('fat-body'),
  fatCloseBtn: document.getElementById('fat-close-btn'),
  soundboardDock: document.getElementById('soundboard-dock'),
  padsRow: document.getElementById('pads-row'),
  stopPadsBtn: document.getElementById('stop-pads-btn'),
  wavUploadInput: document.getElementById('wav-upload-input'),
  bgmUploadInput: document.getElementById('bgm-upload-input'),
  bgmTrackLabel: document.getElementById('bgm-track-label'),
  bgmLoadBtn: document.getElementById('bgm-load-btn'),
  bgmPlayBtn: document.getElementById('bgm-play-btn'),
  bgmLoopBtn: document.getElementById('bgm-loop-btn'),
  audioDialog: document.getElementById('audio-dialog'),
  adStatusSub: document.getElementById('ad-status-sub'),
  selInputDev: document.getElementById('sel-input-dev'),
  selMusicInputDev: document.getElementById('sel-music-input-dev'),
  selMonDev: document.getElementById('sel-mon-dev'),
  selStreamDev: document.getElementById('sel-stream-dev'),
  selBufSize: document.getElementById('sel-buf-size'),
  refreshDevBtn: document.getElementById('refresh-dev-btn'),
  applyAudioBtn: document.getElementById('apply-audio-btn'),
  remoteDialog: document.getElementById('remote-dialog'),
  lanList: document.getElementById('lan-list'),
  resetAllBtn: document.getElementById('reset-all-btn'),
};

const DM_SCALE_TICKS = ['10', '5', '0', '5', '10', '20', '30', '40', '50', '∞'];
const LED_THRESHOLDS_DB = [-36, -28, -22, -16, -12, -9, -6, -3, 0, 3, 6, 10];
const SOURCE_LABELS = ['Mic HW', 'BGM+Loop', 'Loopback', 'Soundboard', 'FX Bus'];

function syncSlider(el) {
  el.style.setProperty('--attr-min', el.min || '0');
  el.style.setProperty('--attr-max', el.max || '100');
  el.style.setProperty('--control-value', el.value);
}

function faderToLinearSlider(db) {
  if (db <= -90) return 0;
  if (db >= 10) return 100;
  if (db >= 0) return Math.round(78 + (db / 10) * 22);
  return Math.max(0, Math.round(Math.pow((db + 90) / 90, 2.2) * 78));
}

function linearSliderToDb(pos) {
  const p = Number(pos);
  if (p <= 0) return -90;
  if (p >= 78) return Number((((p - 78) / 22) * 10).toFixed(1));
  const db = -90 * (1 - Math.pow(p / 78, 1 / 2.2));
  return Number(db.toFixed(1));
}

function formatDb(db) {
  if (db <= -89) return '-∞';
  return `${db > 0 ? '+' : ''}${Number(db).toFixed(1)}`;
}

function dbToMeterPct(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function addDoubleTapReset(el, resetFn) {
  let lastTap = 0;
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetFn();
  });
  el.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 280) {
      resetFn();
      lastTap = 0;
    } else {
      lastTap = now;
    }
  });
}

function sendWs(obj) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(obj));
  }
}

function setChParam(index, key, value) {
  if (!app.state?.channels[index]) return;
  app.state.channels[index][key] = value;
  sendWs({ type: 'ch_param', index, key, value });
}

function setGlobalParam(key, value) {
  if (!app.state?.globals) return;
  app.state.globals[key] = value;
  sendWs({ type: 'global_param', key, value });
}

function createRotaryKnob({ label, value, min, max, step, defaultVal, capClass, formatVal, onChange }) {
  const cell = document.createElement('div');
  cell.className = 'knob-cell';

  const lbl = document.createElement('div');
  lbl.className = 'knob-lbl';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = label;
  const valSpan = document.createElement('span');
  valSpan.className = 'knob-val-sub';
  lbl.append(nameSpan, valSpan);

  const dial = document.createElement('div');
  dial.className = `rotary ${capClass || 'cap-dark'}`;
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', label);
  dial.setAttribute('aria-valuemin', String(min));
  dial.setAttribute('aria-valuemax', String(max));

  let cur = Math.max(min, Math.min(max, Number(value)));

  const syncVisual = (v) => {
    cur = Math.max(min, Math.min(max, v));
    const norm = (cur - min) / (max - min || 1);
    const angle = -135 + norm * 270;
    dial.style.setProperty('--angle', `${angle.toFixed(1)}deg`);
    dial.setAttribute('aria-valuenow', String(cur));
    valSpan.textContent = formatVal ? formatVal(cur) : String(cur);
  };
  syncVisual(cur);

  const commit = (nextVal) => {
    const snapped = Math.round((nextVal - min) / step) * step + min;
    const clamped = Number(Math.max(min, Math.min(max, snapped)).toFixed(3));
    if (clamped === cur) return;
    syncVisual(clamped);
    onChange(clamped);
  };

  let dragging = false;
  let startY = 0;
  let startVal = cur;

  dial.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startVal = cur;
    dial.setPointerCapture(e.pointerId);
    dial.focus();
  });

  dial.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = (startY - e.clientY) / 115;
    commit(startVal + delta * (max - min));
  });

  const endDrag = () => {
    dragging = false;
  };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);

  dial.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const mult = e.shiftKey ? 0.25 : 1;
      commit(cur + dir * step * mult * 2);
    },
    { passive: false },
  );

  dial.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      commit(cur + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      commit(cur - step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commit(defaultVal);
    }
  });

  addDoubleTapReset(dial, () => commit(defaultVal));
  cell.append(lbl, dial);
  return cell;
}

function createDmScale() {
  const col = document.createElement('div');
  col.className = 'dm-scale';
  for (const t of DM_SCALE_TICKS) {
    const sp = document.createElement('span');
    sp.textContent = t;
    col.append(sp);
  }
  return col;
}

function connectWs() {
  clearTimeout(app.reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  app.ws = ws;
  dom.wsDot.className = 'ws-dot';

  ws.addEventListener('open', () => {
    app.reconnectDelay = 800;
    dom.wsDot.className = 'ws-dot is-online';
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'init':
        app.state = msg.state;
        app.devices = msg.devices || [];
        app.audioStatus = msg.audioStatus || app.audioStatus;
        app.lanUrls = msg.lanUrls || [];
        renderAll();
        break;
      case 'full_state':
        app.state = msg.state;
        renderAll();
        break;
      case 'devices':
        app.devices = msg.devices || [];
        populateDeviceSelects();
        renderMasters();
        break;
      case 'audio_status':
        app.audioStatus = msg.status;
        syncTopStatus();
        break;
      case 'meters':
        updateLiveMeters(msg.meters);
        break;
      case 'ch_update':
        if (app.state?.channels[msg.index]) {
          app.state.channels[msg.index][msg.key] = msg.value;
          renderConsole();
          if (!dom.fatPanel.hidden && app.state.selectedChannel === msg.index) {
            renderFatChannel();
          }
        }
        break;
      case 'global_update':
        if (app.state?.globals) {
          app.state.globals[msg.key] = msg.value;
          syncTopStatus();
          renderMasters();
        }
        break;
      case 'selected_channel':
        if (app.state) {
          app.state.selectedChannel = msg.index;
          renderConsole();
          if (!dom.fatPanel.hidden) renderFatChannel();
        }
        break;
      case 'pad_hit':
        flashPad(msg.index);
        break;
      default:
        break;
    }
  });

  ws.addEventListener('close', () => {
    dom.wsDot.className = 'ws-dot is-offline';
    dom.audioStatusLabel.textContent = 'Reconnecting...';
    app.reconnectTimer = setTimeout(connectWs, app.reconnectDelay);
    app.reconnectDelay = Math.min(4000, app.reconnectDelay * 1.5);
  });

  ws.addEventListener('error', () => ws.close());
}

function updateLedColumn(colEl, peakDb) {
  if (!colEl) return;
  const segs = colEl.children;
  for (let i = 0; i < segs.length; i++) {
    segs[i].classList.toggle('on', peakDb >= LED_THRESHOLDS_DB[i]);
  }
}

function updateLiveMeters(m) {
  if (!m) return;
  if (Array.isArray(m.ch)) {
    m.ch.forEach((pair, idx) => {
      const peakMax = Math.max(Number(pair[0] ?? -90), Number(pair[1] ?? -90));
      const meterEl = document.querySelector(`[data-ch-meter="${idx}"]`);
      if (meterEl) meterEl.style.setProperty('--meter-pct', `${dbToMeterPct(peakMax)}%`);
      const peakLed = document.querySelector(`[data-ch-peak="${idx}"]`);
      if (peakLed) peakLed.classList.toggle('is-hot', peakMax >= -4.0);
      if (app.state?.selectedChannel === idx) {
        const grEl = document.getElementById('fat-comp-gr');
        if (grEl) grEl.textContent = `GR: -${Number(pair[2] || 0).toFixed(1)} dB`;
      }
    });
  }

  const activePair = app.meterBus === 'monitor' ? m.monitor : m.stream;
  if (Array.isArray(activePair)) {
    updateLedColumn(document.getElementById('master-led-l'), activePair[0]);
    updateLedColumn(document.getElementById('master-led-r'), activePair[1]);
  }
  if (Array.isArray(m.stream)) {
    const sl = document.querySelector('[data-master-meter="stream"]');
    if (sl) sl.style.setProperty('--meter-pct', `${dbToMeterPct(Math.max(m.stream[0], m.stream[1]))}%`);
  }
  if (Array.isArray(m.monitor)) {
    const ml = document.querySelector('[data-master-meter="monitor"]');
    if (ml) ml.style.setProperty('--meter-pct', `${dbToMeterPct(Math.max(m.monitor[0], m.monitor[1]))}%`);
  }
  if (typeof m.duckDb === 'number') {
    dom.duckDbBadge.textContent = m.duckDb < -0.5 ? `${m.duckDb.toFixed(1)} dB` : '0 dB';
  }
}

function syncTopStatus() {
  if (!app.state) return;
  dom.audioStatusLabel.textContent = app.audioStatus?.text || 'Audio Setup';
  dom.adStatusSub.textContent = app.audioStatus?.text || 'CoreAudio / WASAPI';
  dom.autoDuckBtn.setAttribute('aria-pressed', String(Boolean(app.state.globals.autoDuckEnabled)));
  dom.toggleFatBtn.setAttribute('aria-pressed', String(!dom.fatPanel.hidden));
  dom.togglePadsBtn.setAttribute('aria-pressed', String(!dom.soundboardDock.hidden));
  const bgmPlaying = Boolean(app.state.globals.bgmPlaying);
  const bgmLoop = app.state.globals.bgmLoop !== false;
  dom.bgmPlayBtn.setAttribute('aria-pressed', String(bgmPlaying));
  dom.bgmPlayBtn.textContent = bgmPlaying ? 'Pause' : 'Play';
  dom.bgmLoopBtn.setAttribute('aria-pressed', String(bgmLoop));
  dom.bgmTrackLabel.textContent = app.state.bgm?.trackName
    ? `BGM: ${app.state.bgm.trackName}`
    : 'BGM: Kosong';
}

function renderSceneBar() {
  if (!app.state) return;
  dom.sceneBar.replaceChildren();
  for (const sc of app.state.scenes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scene-pill${sc.id === app.state.activeSceneId ? ' is-active' : ''}`;
    btn.textContent = sc.name;
    btn.addEventListener('click', () => {
      sendWs({ type: 'recall_scene', sceneId: sc.id });
    });
    dom.sceneBar.append(btn);
  }
}

function resolveDeviceShortName(devId, fallbackText) {
  if (!devId || devId === 'none') return 'Off';
  if (devId === 'default') return fallbackText || 'System Default';
  const found = app.devices.find((d) => d.id === devId);
  return found ? found.name : devId;
}

function describeChannelInput(ch) {
  const mode = Number(ch.sourceMode ?? 0);
  if (mode === 0) {
    const dev = resolveDeviceShortName(app.state.audioConfig?.inputDevId, 'Default Mic');
    return `In${Number(ch.inputChannelOffset || 0) + 1}: ${dev}`;
  }
  if (mode === 1) {
    if (app.state.bgm?.trackName) return `Deck: ${app.state.bgm.trackName}`;
    const mus = resolveDeviceShortName(app.state.audioConfig?.musicInputDevId, 'Loopback');
    return mus === 'Off' ? 'BGM Deck / Loop' : mus;
  }
  if (mode === 2) {
    const mus = resolveDeviceShortName(app.state.audioConfig?.musicInputDevId, 'Loopback');
    return mus === 'Off' ? 'Loopback (Off)' : mus;
  }
  return SOURCE_LABELS[mode] || 'Input';
}

function renderConsole() {
  if (!app.state) return;
  dom.consoleRack.replaceChildren();

  for (const ch of app.state.channels) {
    const isStereo = ch.faderColor === 'green';
    const strip = document.createElement('div');
    strip.className = `dm-strip${ch.index === app.state.selectedChannel ? ' is-selected' : ''}${isStereo ? ' is-stereo' : ''}`;

    // Compact Top Patch / Input Slot
    const patch = document.createElement('div');
    patch.className = 'strip-patch';

    const patchTop = document.createElement('div');
    patchTop.className = 'patch-top';

    const chBadge = document.createElement('span');
    chBadge.className = 'ch-num-top';
    chBadge.textContent = ch.index === 6 ? '7-8' : ch.index === 7 ? '9-10' : String(ch.index + 1);

    const miniRoutes = document.createElement('div');
    miniRoutes.className = 'mini-routes';

    const obsBtn = document.createElement('button');
    obsBtn.type = 'button';
    obsBtn.className = 'mini-pill obs';
    obsBtn.textContent = 'OBS';
    obsBtn.setAttribute('aria-pressed', String(Boolean(ch.routeStream)));
    obsBtn.addEventListener('click', () => {
      setChParam(ch.index, 'routeStream', !ch.routeStream);
      obsBtn.setAttribute('aria-pressed', String(ch.routeStream));
    });

    const monBtn = document.createElement('button');
    monBtn.type = 'button';
    monBtn.className = 'mini-pill mon';
    monBtn.textContent = 'MON';
    monBtn.setAttribute('aria-pressed', String(Boolean(ch.routeMonitor)));
    monBtn.addEventListener('click', () => {
      setChParam(ch.index, 'routeMonitor', !ch.routeMonitor);
      monBtn.setAttribute('aria-pressed', String(ch.routeMonitor));
    });

    const dspBtn = document.createElement('button');
    dspBtn.type = 'button';
    dspBtn.className = 'mini-pill dsp';
    dspBtn.textContent = 'DSP';
    dspBtn.addEventListener('click', () => {
      app.state.selectedChannel = ch.index;
      dom.fatPanel.hidden = false;
      syncTopStatus();
      renderConsole();
      renderFatChannel();
    });

    miniRoutes.append(obsBtn, monBtn, dspBtn);
    patchTop.append(chBadge, miniRoutes);

    const srcBtn = document.createElement('button');
    srcBtn.type = 'button';
    srcBtn.className = 'input-source-btn';
    srcBtn.title = 'Klik untuk atur Audio Device / DSP Input';
    srcBtn.textContent = describeChannelInput(ch);
    srcBtn.addEventListener('click', () => {
      app.state.selectedChannel = ch.index;
      sendWs({ type: 'refresh_devices' });
      populateDeviceSelects();
      dom.audioDialog.showModal();
    });

    patch.append(patchTop, srcBtn);

    // Gain Knob
    const gainKnob = createRotaryKnob({
      label: 'Gain',
      value: ch.trimDb,
      min: -20,
      max: 24,
      step: 0.5,
      defaultVal: 0,
      capClass: 'cap-dark',
      formatVal: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`,
      onChange: (v) => setChParam(ch.index, 'trimDb', v),
    });

    // Iconic Midas DM12 White EQ Strip
    const eqBox = document.createElement('div');
    eqBox.className = 'eq-white-panel';

    const trebleKnob = createRotaryKnob({
      label: 'Treb',
      value: ch.eqHighDb,
      min: -15,
      max: 15,
      step: 0.5,
      defaultVal: 0,
      capClass: 'cap-dark',
      formatVal: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`,
      onChange: (v) => setChParam(ch.index, 'eqHighDb', v),
    });

    const freqKnob = createRotaryKnob({
      label: 'Freq',
      value: ch.eqMidHz ?? 1200,
      min: 150,
      max: 3500,
      step: 50,
      defaultVal: 1200,
      capClass: 'cap-cyan',
      formatVal: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
      onChange: (v) => setChParam(ch.index, 'eqMidHz', v),
    });

    const midKnob = createRotaryKnob({
      label: 'Mid',
      value: ch.eqMidDb,
      min: -15,
      max: 15,
      step: 0.5,
      defaultVal: 0,
      capClass: 'cap-cyan',
      formatVal: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`,
      onChange: (v) => setChParam(ch.index, 'eqMidDb', v),
    });

    const bassKnob = createRotaryKnob({
      label: 'Bass',
      value: ch.eqLowDb,
      min: -15,
      max: 15,
      step: 0.5,
      defaultVal: 0,
      capClass: 'cap-dark',
      formatVal: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`,
      onChange: (v) => setChParam(ch.index, 'eqLowDb', v),
    });

    eqBox.append(trebleKnob, freqKnob, midKnob, bassKnob);

    // Aux 1 (Reverb Send) & Aux 2 (Voice Comp Drive) — Emerald Green Caps
    const aux1Knob = createRotaryKnob({
      label: 'Aux1',
      value: ch.reverbSend ?? 0,
      min: 0,
      max: 1,
      step: 0.02,
      defaultVal: 0,
      capClass: 'cap-green',
      formatVal: (v) => `${Math.round(v * 100)}`,
      onChange: (v) => setChParam(ch.index, 'reverbSend', v),
    });

    const compDriveVal = ch.compOn ? Math.max(0.05, Math.min(1, ((ch.compRatio || 3) - 1.5) / 4.5)) : 0;
    const aux2Knob = createRotaryKnob({
      label: 'Aux2',
      value: compDriveVal,
      min: 0,
      max: 1,
      step: 0.05,
      defaultVal: 0.35,
      capClass: 'cap-green',
      formatVal: (v) => (v <= 0.02 ? 'Off' : `C${Math.round(v * 10)}`),
      onChange: (v) => {
        if (v <= 0.02) {
          setChParam(ch.index, 'compOn', false);
        } else {
          setChParam(ch.index, 'compOn', true);
          setChParam(ch.index, 'compRatio', Number((1.5 + v * 4.5).toFixed(1)));
          setChParam(ch.index, 'compThreshDb', Math.round(-10 - v * 20));
        }
      },
    });

    // Red Pan Knob
    const panKnob = createRotaryKnob({
      label: isStereo ? 'Bal' : 'Pan',
      value: ch.pan ?? 0,
      min: -1,
      max: 1,
      step: 0.05,
      defaultVal: 0,
      capClass: 'cap-red',
      formatVal: (v) => (Math.abs(v) < 0.05 ? 'C' : v < 0 ? `L${Math.round(-v * 10)}` : `R${Math.round(v * 10)}`),
      onChange: (v) => setChParam(ch.index, 'pan', v),
    });

    // PFL (White) + MUTE (Red) + PEAK LED
    const swRow = document.createElement('div');
    swRow.className = 'switch-row';

    const pflBtn = document.createElement('button');
    pflBtn.type = 'button';
    pflBtn.className = 'dm-hw-btn pfl';
    pflBtn.textContent = 'PFL';
    pflBtn.setAttribute('aria-pressed', String(Boolean(ch.solo)));
    pflBtn.addEventListener('click', () => {
      setChParam(ch.index, 'solo', !ch.solo);
      pflBtn.setAttribute('aria-pressed', String(ch.solo));
    });

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'dm-hw-btn mute';
    muteBtn.textContent = 'MUTE';
    muteBtn.setAttribute('aria-pressed', String(Boolean(ch.mute)));
    muteBtn.addEventListener('click', () => {
      setChParam(ch.index, 'mute', !ch.mute);
      muteBtn.setAttribute('aria-pressed', String(ch.mute));
    });

    const peakWrap = document.createElement('div');
    peakWrap.className = 'peak-led-wrap';
    const peakLed = document.createElement('span');
    peakLed.className = 'peak-led';
    peakLed.dataset.chPeak = String(ch.index);
    const peakLbl = document.createElement('span');
    peakLbl.className = 'peak-lbl';
    peakLbl.textContent = 'pk';
    peakWrap.append(peakLed, peakLbl);

    swRow.append(pflBtn, muteBtn, peakWrap);

    // Hardware Fader Stage
    const faderStage = document.createElement('div');
    faderStage.className = 'fader-stage';

    const meterSlim = document.createElement('div');
    meterSlim.className = 'strip-meter-slim';
    const meterFill = document.createElement('div');
    meterFill.className = 'strip-meter-fill';
    meterFill.dataset.chMeter = String(ch.index);
    meterSlim.append(meterFill);

    const trackWrap = document.createElement('div');
    trackWrap.className = 'fader-track-wrap';
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = `dm-fader${isStereo ? ' cap-green' : ''}`;
    fader.min = '0';
    fader.max = '100';
    fader.step = '1';
    fader.value = String(faderToLinearSlider(ch.faderDb));
    fader.ariaLabel = `Fader ${ch.name}`;
    syncSlider(fader);

    const dbReadout = document.createElement('div');
    dbReadout.className = 'fader-db-mini';
    dbReadout.textContent = `${formatDb(ch.faderDb)} dB`;

    fader.addEventListener('input', () => {
      syncSlider(fader);
      const db = linearSliderToDb(fader.value);
      dbReadout.textContent = `${formatDb(db)} dB`;
      setChParam(ch.index, 'faderDb', db);
    });
    addDoubleTapReset(fader, () => {
      fader.value = String(faderToLinearSlider(0));
      fader.dispatchEvent(new Event('input'));
    });

    trackWrap.append(fader);
    faderStage.append(createDmScale(), trackWrap, meterSlim);

    // Bottom White/Green Recessed Plate
    const foot = document.createElement('div');
    foot.className = 'strip-foot';
    const plate = document.createElement('button');
    plate.type = 'button';
    plate.className = 'ch-plate-btn';
    plate.textContent = ch.name;
    plate.title = 'Klik untuk buka DSP & Rename Channel';
    plate.addEventListener('click', () => {
      app.state.selectedChannel = ch.index;
      dom.fatPanel.hidden = false;
      syncTopStatus();
      renderConsole();
      renderFatChannel();
    });
    foot.append(dbReadout, plate);

    strip.append(patch, gainKnob, eqBox, aux1Knob, aux2Knob, panKnob, swRow, faderStage, foot);
    dom.consoleRack.append(strip);
  }
}

function buildLedColumn(id) {
  const col = document.createElement('div');
  col.className = 'led-col';
  col.id = id;
  for (let i = 0; i < LED_THRESHOLDS_DB.length; i++) {
    const seg = document.createElement('span');
    const tier = i >= 10 ? 'red' : i >= 8 ? 'yellow' : 'green';
    seg.className = `led-seg ${tier}`;
    col.append(seg);
  }
  return col;
}

function renderMasters() {
  if (!app.state) return;
  dom.masterRack.replaceChildren();

  // 1. Audio Device Quick Patch Box (replaces upper master RCA/XLR jacks)
  const patchBox = document.createElement('div');
  patchBox.className = 'master-patch-box';

  const patchHead = document.createElement('div');
  patchHead.className = 'patch-box-head';
  const phLeft = document.createElement('span');
  phLeft.textContent = 'AUDIO I/O PATCH';
  const phBtn = document.createElement('button');
  phBtn.type = 'button';
  phBtn.className = 'dm-btn small';
  phBtn.textContent = 'Setup';
  phBtn.addEventListener('click', () => dom.audioSetupBtn.click());
  patchHead.append(phLeft, phBtn);

  const devGrid = document.createElement('div');
  devGrid.className = 'patch-device-grid';
  const cfg = app.state.audioConfig || {};
  const chips = [
    ['MIC IN', resolveDeviceShortName(cfg.inputDevId, 'Default Mic')],
    ['BGM / LOOP', resolveDeviceShortName(cfg.musicInputDevId, 'None')],
    ['PHONES / MON', resolveDeviceShortName(cfg.monitorOutDevId, 'Default Out')],
    ['STREAM OBS/TTLS', resolveDeviceShortName(cfg.streamOutDevId, 'None')],
  ];
  for (const [k, v] of chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dev-chip';
    chip.innerHTML = `<span class="dev-chip-k"></span><span class="dev-chip-v"></span>`;
    chip.querySelector('.dev-chip-k').textContent = k;
    chip.querySelector('.dev-chip-v').textContent = v;
    chip.addEventListener('click', () => dom.audioSetupBtn.click());
    devGrid.append(chip);
  }
  patchBox.append(patchHead, devGrid);

  // 2. Aux Masters / FX + Master Segmented LED Meters
  const midGrid = document.createElement('div');
  midGrid.className = 'master-mid-grid';

  const auxBox = document.createElement('div');
  auxBox.className = 'master-box';
  const auxTitle = document.createElement('div');
  auxTitle.className = 'master-box-title';
  auxTitle.textContent = 'AUX / FX / DUCK';

  const knobsPair = document.createElement('div');
  knobsPair.className = 'master-knobs-pair';
  knobsPair.append(
    createRotaryKnob({
      label: 'FX Ret',
      value: app.state.globals.fxReturnDb ?? -6,
      min: -60,
      max: 6,
      step: 1,
      defaultVal: -6,
      capClass: 'cap-green',
      formatVal: (v) => (v <= -59 ? '-∞' : `${v > 0 ? '+' : ''}${Math.round(v)}`),
      onChange: (v) => setGlobalParam('fxReturnDb', v),
    }),
    createRotaryKnob({
      label: 'Decay',
      value: app.state.globals.reverbDecay ?? 0.75,
      min: 0.2,
      max: 0.95,
      step: 0.05,
      defaultVal: 0.75,
      capClass: 'cap-cyan',
      formatVal: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => setGlobalParam('reverbDecay', v),
    }),
    createRotaryKnob({
      label: 'Duck',
      value: app.state.globals.autoDuckDepthDb ?? -10,
      min: -24,
      max: 0,
      step: 1,
      defaultVal: -10,
      capClass: 'cap-dark',
      formatVal: (v) => `${Math.round(v)}`,
      onChange: (v) => setGlobalParam('autoDuckDepthDb', v),
    }),
  );

  const fxBtnCol = document.createElement('div');
  fxBtnCol.className = 'knob-cell';
  fxBtnCol.style.justifyContent = 'center';
  const fxMuteBtn = document.createElement('button');
  fxMuteBtn.type = 'button';
  fxMuteBtn.className = 'dm-hw-btn mute';
  fxMuteBtn.style.width = '100%';
  fxMuteBtn.textContent = 'FX MUTE';
  fxMuteBtn.setAttribute('aria-pressed', String(Boolean(app.state.globals.fxReturnMute)));
  fxMuteBtn.addEventListener('click', () => {
    setGlobalParam('fxReturnMute', !app.state.globals.fxReturnMute);
    fxMuteBtn.setAttribute('aria-pressed', String(app.state.globals.fxReturnMute));
  });

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'dm-btn small';
  testBtn.style.width = '100%';
  testBtn.textContent = 'Test Tone';
  testBtn.setAttribute('aria-pressed', String(Boolean(app.state.channels[0]?.testTone)));
  testBtn.addEventListener('click', () => {
    const ch0 = app.state.channels[0];
    if (!ch0) return;
    setChParam(0, 'testTone', !ch0.testTone);
    testBtn.setAttribute('aria-pressed', String(ch0.testTone));
  });

  fxBtnCol.append(fxMuteBtn, testBtn);
  knobsPair.append(fxBtnCol);
  auxBox.append(auxTitle, knobsPair);

  // Segmented Master Meters Box
  const metersBox = document.createElement('div');
  metersBox.className = 'master-meters-box';
  const mTitle = document.createElement('div');
  mTitle.className = 'master-box-title';
  mTitle.textContent = 'MASTER METERS';

  const modeTabs = document.createElement('div');
  modeTabs.className = 'meter-mode-tabs';
  for (const [key, lbl] of [['stream', 'STREAM'], ['monitor', 'PHONES']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-btn small';
    b.style.flex = '1';
    b.textContent = lbl;
    b.setAttribute('aria-pressed', String(app.meterBus === key));
    b.addEventListener('click', () => {
      app.meterBus = key;
      renderMasters();
    });
    modeTabs.append(b);
  }

  const ledPair = document.createElement('div');
  ledPair.className = 'led-meters-pair';
  const scaleCol = document.createElement('div');
  scaleCol.className = 'led-scale-col';
  for (const lbl of ['+10', '+6', '0', '-6', '-12', '-22']) {
    const s = document.createElement('span');
    s.textContent = lbl;
    scaleCol.append(s);
  }
  ledPair.append(buildLedColumn('master-led-l'), scaleCol, buildLedColumn('master-led-r'));
  metersBox.append(mTitle, modeTabs, ledPair);

  midGrid.append(auxBox, metersBox);

  // 3. Dual Red Hardware Master Faders (Stream Out + Monitor Out)
  const fadersRow = document.createElement('div');
  fadersRow.className = 'master-faders-row';

  const defs = [
    {
      label: 'STREAM (OBS)',
      dbKey: 'streamMasterDb',
      muteKey: 'streamMasterMute',
      meterKey: 'stream',
      plateClass: 'master-plate',
    },
    {
      label: 'PHONES (MON)',
      dbKey: 'monitorMasterDb',
      muteKey: 'monitorMasterMute',
      meterKey: 'monitor',
      plateClass: 'master-plate mon',
    },
  ];

  for (const d of defs) {
    const col = document.createElement('div');
    col.className = 'master-fader-col';

    const head = document.createElement('div');
    head.className = 'master-fader-head';
    const valSpan = document.createElement('span');
    valSpan.textContent = `${formatDb(app.state.globals[d.dbKey])} dB`;
    const mBtn = document.createElement('button');
    mBtn.type = 'button';
    mBtn.className = 'dm-hw-btn mute';
    mBtn.style.maxWidth = '46px';
    mBtn.style.height = '17px';
    mBtn.textContent = 'MUTE';
    mBtn.setAttribute('aria-pressed', String(Boolean(app.state.globals[d.muteKey])));
    mBtn.addEventListener('click', () => {
      setGlobalParam(d.muteKey, !app.state.globals[d.muteKey]);
      mBtn.setAttribute('aria-pressed', String(app.state.globals[d.muteKey]));
    });
    head.append(valSpan, mBtn);

    const stage = document.createElement('div');
    stage.className = 'fader-stage';
    const mSlim = document.createElement('div');
    mSlim.className = 'strip-meter-slim';
    const mFill = document.createElement('div');
    mFill.className = 'strip-meter-fill';
    mFill.dataset.masterMeter = d.meterKey;
    mSlim.append(mFill);

    const wrap = document.createElement('div');
    wrap.className = 'fader-track-wrap';
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'dm-fader cap-red';
    fader.min = '0';
    fader.max = '100';
    fader.step = '1';
    fader.value = String(faderToLinearSlider(app.state.globals[d.dbKey]));
    fader.ariaLabel = d.label;
    syncSlider(fader);

    fader.addEventListener('input', () => {
      syncSlider(fader);
      const db = linearSliderToDb(fader.value);
      valSpan.textContent = `${formatDb(db)} dB`;
      setGlobalParam(d.dbKey, db);
    });
    addDoubleTapReset(fader, () => {
      fader.value = String(faderToLinearSlider(0));
      fader.dispatchEvent(new Event('input'));
    });

    wrap.append(fader);
    stage.append(createDmScale(), wrap, mSlim);

    const plate = document.createElement('div');
    plate.className = d.plateClass;
    plate.textContent = d.label;

    col.append(head, stage, plate);
    fadersRow.append(col);
  }

  dom.masterRack.append(patchBox, midGrid, fadersRow);
}

function renderFatChannel() {
  if (!app.state) return;
  const ch = app.state.channels[app.state.selectedChannel] || app.state.channels[0];
  dom.fatChannelName.textContent = `CH ${ch.index + 1} — ${ch.name}`;
  dom.fatBody.replaceChildren();

  const makeCard = (title, toggleKey, buildBody) => {
    const card = document.createElement('div');
    card.className = 'dsp-card';
    const head = document.createElement('div');
    head.className = 'dsp-card-head';
    const t = document.createElement('span');
    t.textContent = title;
    head.append(t);

    if (toggleKey) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dm-btn small';
      btn.textContent = ch[toggleKey] ? 'ON' : 'OFF';
      btn.setAttribute('aria-pressed', String(Boolean(ch[toggleKey])));
      btn.addEventListener('click', () => {
        setChParam(ch.index, toggleKey, !ch[toggleKey]);
        renderConsole();
        renderFatChannel();
      });
      head.append(btn);
    }
    card.append(head);
    buildBody(card);
    return card;
  };

  const addSlider = (card, label, key, min, max, step, suffix = '') => {
    const row = document.createElement('div');
    row.className = 'dsp-slider-row';
    const top = document.createElement('div');
    top.className = 'dsp-slider-top';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const valEl = document.createElement('span');
    valEl.textContent = `${ch[key]}${suffix}`;
    top.append(lbl, valEl);

    const sl = document.createElement('input');
    sl.type = 'range';
    sl.min = String(min);
    sl.max = String(max);
    sl.step = String(step);
    sl.value = String(ch[key]);
    sl.addEventListener('input', () => {
      const v = Number(sl.value);
      valEl.textContent = `${v}${suffix}`;
      setChParam(ch.index, key, v);
      renderConsole();
    });
    row.append(top, sl);
    card.append(row);
  };

  // Source & Channel Name
  dom.fatBody.append(
    makeCard('Input Source & Label', null, (card) => {
      const nameRow = document.createElement('div');
      nameRow.className = 'form-row';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = ch.name;
      inp.maxLength = 18;
      inp.style.cssText = 'background:#090d20;color:#fff;border:1px solid #35417a;border-radius:4px;padding:4px 6px;font-size:0.76rem;';
      inp.addEventListener('change', () => {
        sendWs({ type: 'rename_channel', index: ch.index, name: inp.value });
      });
      nameRow.append(inp);

      const srcRow = document.createElement('div');
      srcRow.className = 'form-row';
      const srcSel = document.createElement('select');
      for (const [val, txt] of [
        ['0', 'Mic Hardware (Audio Setup)'],
        ['1', 'BGM Deck + Loopback'],
        ['2', 'Loopback / Aux Device'],
        ['3', 'Soundboard Pads'],
      ]) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        srcSel.append(o);
      }
      srcSel.value = String(ch.sourceMode ?? 0);
      srcSel.addEventListener('change', () => {
        setChParam(ch.index, 'sourceMode', Number(srcSel.value));
        renderConsole();
      });
      srcRow.append(srcSel);

      const chOffSel = document.createElement('select');
      for (let i = 0; i < 4; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `Hardware Input Ch ${i + 1}${i < 3 ? `–${i + 2}` : ''}`;
        chOffSel.append(o);
      }
      chOffSel.value = String(ch.inputChannelOffset ?? 0);
      chOffSel.addEventListener('change', () => {
        setChParam(ch.index, 'inputChannelOffset', Number(chOffSel.value));
        renderConsole();
      });

      card.append(nameRow, srcRow, chOffSel);
    }),
  );

  // HPF & Noise Gate
  dom.fatBody.append(
    makeCard('High-Pass & Noise Gate', 'gateOn', (card) => {
      const hpfRow = document.createElement('div');
      hpfRow.style.display = 'flex';
      hpfRow.style.justifyContent = 'space-between';
      hpfRow.style.alignItems = 'center';
      const hpfBtn = document.createElement('button');
      hpfBtn.type = 'button';
      hpfBtn.className = 'dm-btn small';
      hpfBtn.textContent = `HPF: ${ch.hpfOn ? 'ON' : 'OFF'}`;
      hpfBtn.setAttribute('aria-pressed', String(Boolean(ch.hpfOn)));
      hpfBtn.addEventListener('click', () => {
        setChParam(ch.index, 'hpfOn', !ch.hpfOn);
        renderFatChannel();
      });
      const phiBtn = document.createElement('button');
      phiBtn.type = 'button';
      phiBtn.className = 'dm-btn small';
      phiBtn.textContent = `Phase Ø: ${ch.phaseInvert ? 'INV' : 'NRM'}`;
      phiBtn.setAttribute('aria-pressed', String(Boolean(ch.phaseInvert)));
      phiBtn.addEventListener('click', () => {
        setChParam(ch.index, 'phaseInvert', !ch.phaseInvert);
        renderFatChannel();
      });
      hpfRow.append(hpfBtn, phiBtn);
      card.append(hpfRow);
      addSlider(card, 'HPF Cutoff', 'hpfHz', 30, 220, 5, ' Hz');
      addSlider(card, 'Gate Threshold', 'gateThreshDb', -65, -20, 1, ' dB');
    }),
  );

  // Compressor
  dom.fatBody.append(
    makeCard('Dynamics Compressor', 'compOn', (card) => {
      const gr = document.createElement('div');
      gr.id = 'fat-comp-gr';
      gr.style.fontSize = '0.68rem';
      gr.style.color = '#facc15';
      gr.textContent = 'GR: 0.0 dB';
      card.append(gr);
      addSlider(card, 'Threshold', 'compThreshDb', -40, 0, 1, ' dB');
      addSlider(card, 'Ratio', 'compRatio', 1.2, 8, 0.2, ':1');
      addSlider(card, 'Makeup Gain', 'compMakeupDb', 0, 12, 0.5, ' dB');
    }),
  );
}

function flashPad(idx) {
  const btn = dom.padsRow.querySelector(`[data-pad-idx="${idx}"]`);
  if (!btn) return;
  btn.classList.add('is-hit');
  setTimeout(() => btn.classList.remove('is-hit'), 180);
}

function renderPads() {
  if (!app.state) return;
  dom.padsRow.replaceChildren();
  for (const pad of app.state.pads) {
    const cell = document.createElement('div');
    cell.className = 'pad-cell';
    cell.style.setProperty('--pad-color', pad.color || '#38bdf8');

    const hitBtn = document.createElement('button');
    hitBtn.type = 'button';
    hitBtn.className = 'pad-hit-btn';
    hitBtn.dataset.padIdx = String(pad.index);
    hitBtn.textContent = pad.name;
    hitBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      flashPad(pad.index);
      sendWs({ type: 'pad_trigger', index: pad.index });
    });

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'pad-load-btn';
    loadBtn.textContent = pad.wavPath ? 'Edit' : '+';
    loadBtn.title = 'Load audio file untuk pad ini';
    loadBtn.addEventListener('click', () => {
      app.uploadPadIdx = pad.index;
      dom.wavUploadInput.click();
    });

    cell.append(hitBtn, loadBtn);
    dom.padsRow.append(cell);
  }
}

function populateDeviceSelects() {
  if (!app.state) return;
  const fill = (sel, items, selectedId, includeNone = false) => {
    sel.replaceChildren();
    if (includeNone) {
      const opt = document.createElement('option');
      opt.value = 'none';
      opt.textContent = 'None (Off)';
      sel.append(opt);
    }
    const defOpt = document.createElement('option');
    defOpt.value = 'default';
    defOpt.textContent = 'System Default';
    sel.append(defOpt);
    for (const d of items) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.in > 0 ? `${d.in}in` : ''}${d.out > 0 ? ` ${d.out}out` : ''})`;
      sel.append(opt);
    }
    sel.value = selectedId || 'default';
  };

  const inputs = app.devices.filter((d) => d.in > 0);
  const outputs = app.devices.filter((d) => d.out > 0);
  fill(dom.selInputDev, inputs, app.state.audioConfig.inputDevId, true);
  fill(dom.selMusicInputDev, inputs, app.state.audioConfig.musicInputDevId || 'none', true);
  fill(dom.selMonDev, outputs, app.state.audioConfig.monitorOutDevId, true);
  fill(dom.selStreamDev, outputs, app.state.audioConfig.streamOutDevId, true);
  dom.selBufSize.value = String(app.state.audioConfig.bufferSize || 256);
}

function renderLanList() {
  dom.lanList.replaceChildren();
  if (app.lanUrls.length === 0) {
    const li = document.createElement('li');
    li.textContent = location.origin;
    dom.lanList.append(li);
    return;
  }
  for (const item of app.lanUrls) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = item.url;
    li.append(code, ` (${item.iface})`);
    dom.lanList.append(li);
  }
}

function renderAll() {
  syncTopStatus();
  renderSceneBar();
  renderConsole();
  renderMasters();
  if (!dom.fatPanel.hidden) renderFatChannel();
  renderPads();
  populateDeviceSelects();
  renderLanList();
}

async function decodeAudioFileToWavBuffer(file, targetRate = 48000) {
  const raw = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return raw;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(2, frameCount, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const ch0 = rendered.getChannelData(0);
    const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
    const dataBytes = rendered.length * 4;
    const out = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(out);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    let pos = 44;
    for (let i = 0; i < rendered.length; i++) {
      const l = Math.max(-1, Math.min(1, ch0[i]));
      const r = Math.max(-1, Math.min(1, ch1[i]));
      view.setInt16(pos, l < 0 ? l * 0x8000 : l * 0x7fff, true);
      view.setInt16(pos + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      pos += 4;
    }
    return out;
  } finally {
    await ctx.close();
  }
}

// Event Bindings
dom.autoDuckBtn.addEventListener('click', () => {
  if (!app.state) return;
  const next = !app.state.globals.autoDuckEnabled;
  setGlobalParam('autoDuckEnabled', next);
  syncTopStatus();
});

dom.toggleFatBtn.addEventListener('click', () => {
  dom.fatPanel.hidden = !dom.fatPanel.hidden;
  if (!dom.fatPanel.hidden) renderFatChannel();
  syncTopStatus();
});

dom.fatCloseBtn.addEventListener('click', () => {
  dom.fatPanel.hidden = true;
  syncTopStatus();
});

dom.togglePadsBtn.addEventListener('click', () => {
  dom.soundboardDock.hidden = !dom.soundboardDock.hidden;
  syncTopStatus();
});

dom.stopPadsBtn.addEventListener('click', () => sendWs({ type: 'pad_stop_all' }));

dom.wavUploadInput.addEventListener('change', async () => {
  const file = dom.wavUploadInput.files?.[0];
  if (!file) return;
  try {
    const wavBuf = await decodeAudioFileToWavBuffer(file);
    await fetch(`/api/upload-wav?pad=${app.uploadPadIdx}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: wavBuf,
    });
  } finally {
    dom.wavUploadInput.value = '';
  }
});

dom.bgmLoadBtn.addEventListener('click', () => dom.bgmUploadInput.click());

dom.bgmUploadInput.addEventListener('change', async () => {
  const file = dom.bgmUploadInput.files?.[0];
  if (!file) return;
  dom.bgmTrackLabel.textContent = 'Decoding...';
  try {
    const wavBuf = await decodeAudioFileToWavBuffer(file);
    await fetch(`/api/upload-bgm?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: wavBuf,
    });
  } catch {
    dom.bgmTrackLabel.textContent = 'Gagal memuat audio';
  } finally {
    dom.bgmUploadInput.value = '';
  }
});

dom.bgmPlayBtn.addEventListener('click', () => {
  if (!app.state) return;
  if (!app.state.bgm?.wavPath) {
    dom.bgmUploadInput.click();
    return;
  }
  const next = !app.state.globals.bgmPlaying;
  setGlobalParam('bgmPlaying', next);
  syncTopStatus();
});

dom.bgmLoopBtn.addEventListener('click', () => {
  if (!app.state) return;
  const next = !(app.state.globals.bgmLoop !== false);
  setGlobalParam('bgmLoop', next);
  syncTopStatus();
});

dom.audioSetupBtn.addEventListener('click', () => {
  sendWs({ type: 'refresh_devices' });
  populateDeviceSelects();
  dom.audioDialog.showModal();
});

dom.refreshDevBtn.addEventListener('click', () => sendWs({ type: 'refresh_devices' }));

dom.applyAudioBtn.addEventListener('click', () => {
  const config = {
    inputDevId: dom.selInputDev.value,
    musicInputDevId: dom.selMusicInputDev.value,
    monitorOutDevId: dom.selMonDev.value,
    streamOutDevId: dom.selStreamDev.value,
    bufferSize: Number(dom.selBufSize.value),
  };
  app.state.audioConfig = config;
  sendWs({ type: 'audio_config', config });
  dom.audioDialog.close();
});

dom.remoteInfoBtn.addEventListener('click', () => {
  renderLanList();
  dom.remoteDialog.showModal();
});

dom.resetAllBtn.addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  dom.remoteDialog.close();
});

connectWs();
