(() => {
  'use strict';

  const LOGICAL_W = 1360;
  const LOGICAL_H = 760;

  // Piecewise fader curve matching painted dB ticks (from top: +10 at 0.04, 0 at 0.25 -> val=0.75, -inf at 0.99 -> val=0)
  const FADER_CURVE = [
    [0.0, -90],
    [0.05, -50],
    [0.10, -40],
    [0.18, -30],
    [0.28, -20],
    [0.39, -15],
    [0.51, -10],
    [0.63, -5],
    [0.75, 0],
    [0.86, 5],
    [0.96, 10],
    [1.0, 10],
  ];

  function faderNormToDb(norm) {
    const v = clamp(norm, 0, 1);
    if (v <= 0.005) return -90;
    for (let i = 1; i < FADER_CURVE.length; i++) {
      const [v1, db1] = FADER_CURVE[i];
      if (v <= v1) {
        const [v0, db0] = FADER_CURVE[i - 1];
        const t = (v - v0) / (v1 - v0);
        return Number((db0 + t * (db1 - db0)).toFixed(1));
      }
    }
    return 10;
  }

  function dbToFaderNorm(db) {
    if (db <= -89) return 0;
    if (db >= 10) return 0.96;
    for (let i = 1; i < FADER_CURVE.length; i++) {
      const [v1, db1] = FADER_CURVE[i];
      if (db <= db1) {
        const [v0, db0] = FADER_CURVE[i - 1];
        const t = (db - db0) / (db1 - db0 || 1);
        return clamp(v0 + t * (v1 - v0), 0, 1);
      }
    }
    return 0.75;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function dbToMeterNorm(db) {
    // Map -60 dB .. +6 dB cleanly into 0..1 for LED meters
    if (!Number.isFinite(db) || db <= -72) return 0;
    return clamp((db + 54) / 60, 0, 1);
  }

  function eqMidHzToNorm(hz) {
    return clamp(Math.log(clamp(hz || 1200, 150, 3500) / 150) / Math.log(3500 / 150), 0, 1);
  }

  function normToEqMidHz(norm) {
    return Math.round(150 * Math.pow(3500 / 150, clamp(norm, 0, 1)));
  }

  function getCompDriveNorm(ch) {
    if (!ch || !ch.compOn) return 0;
    const t = clamp((-8 - (ch.compThreshDb ?? -18)) / 28, 0.05, 1);
    return t;
  }

  // DOM References
  const canvas = document.getElementById('mixerCanvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = document.querySelector('.canvas-scroll-wrap');
  const wsDot = document.getElementById('ws-dot');
  const audioSetupBtn = document.getElementById('audio-setup-btn');
  const audioStatusLabel = document.getElementById('audio-status-label');
  const statusReadout = document.getElementById('statusReadout');
  const sceneBar = document.getElementById('scene-bar');
  const bgmUploadInput = document.getElementById('bgm-upload-input');
  const bgmLoadBtn = document.getElementById('bgm-load-btn');
  const bgmTrackLabel = document.getElementById('bgm-track-label');
  const bgmRestartBtn = document.getElementById('bgm-restart-btn');
  const bgmPlayBtn = document.getElementById('bgm-play-btn');
  const bgmLoopBtn = document.getElementById('bgm-loop-btn');
  const autoDuckBtn = document.getElementById('auto-duck-btn');
  const duckDbBadge = document.getElementById('duck-db-badge');
  const togglePadsBtn = document.getElementById('toggle-pads-btn');
  const toggleFatBtn = document.getElementById('toggle-fat-btn');
  const remoteInfoBtn = document.getElementById('remote-info-btn');
  const fatPanel = document.getElementById('fat-panel');
  const fatChannelName = document.getElementById('fat-channel-name');
  const fatBody = document.getElementById('fat-body');
  const fatCloseBtn = document.getElementById('fat-close-btn');
  const soundboardDock = document.getElementById('soundboard-dock');
  const padsRow = document.getElementById('pads-row');
  const stopPadsBtn = document.getElementById('stop-pads-btn');
  const wavUploadInput = document.getElementById('wav-upload-input');
  const audioDialog = document.getElementById('audio-dialog');
  const selInputDev = document.getElementById('sel-input-dev');
  const selMusicInputDev = document.getElementById('sel-music-input-dev');
  const selMonDev = document.getElementById('sel-mon-dev');
  const selStreamDev = document.getElementById('sel-stream-dev');
  const selBufSize = document.getElementById('sel-buf-size');
  const selSampleRate = document.getElementById('sel-sample-rate');
  const audioHwMeta = document.getElementById('audio-hw-meta');
  const refreshDevBtn = document.getElementById('refresh-dev-btn');
  const applyAudioBtn = document.getElementById('apply-audio-btn');
  const presetSelect = document.getElementById('preset-select');
  const savePresetBtn = document.getElementById('save-preset-btn');
  const presetDialog = document.getElementById('preset-dialog');
  const presetNameInput = document.getElementById('preset-name-input');
  const presetList = document.getElementById('preset-list');
  const confirmSavePresetBtn = document.getElementById('confirm-save-preset-btn');
  const remoteDialog = document.getElementById('remote-dialog');
  const lanList = document.getElementById('lan-list');
  const resetAllBtn = document.getElementById('reset-all-btn');

  // Application State
  let ws = null;
  let reconnectTimer = null;
  let appState = null;
  let devices = [];
  let audioStatus = { running: false, sampleRate: 48000, text: 'Connecting...' };
  let lanUrls = [];
  let selectedChannel = 0;
  let meterBusMode = 'stream'; // 'stream' | 'monitor'
  let pendingPadUpload = 0;
  let flashingPads = new Map();

  // Visual smoothed meters (0..1)
  const dispMeters = {
    ch: Array.from({ length: 8 }, () => ({ l: 0, r: 0, rawDb: -96 })),
    stream: { l: 0, r: 0 },
    monitor: { l: 0, r: 0 },
    duckDb: 0,
  };
  const targetMeters = {
    ch: Array.from({ length: 8 }, () => ({ l: -96, r: -96, gr: 0 })),
    stream: [-96, -96],
    monitor: [-96, -96],
    duckDb: 0,
  };

  // Interactive hitboxes rebuilt per render frame
  let interactiveControls = [];
  let activeDrag = null;
  let hoveredControl = null;

  function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function sendChParam(index, key, value) {
    if (!appState || !appState.channels[index]) return;
    appState.channels[index][key] = value;
    sendWs({ type: 'ch_param', index, key, value });
  }

  function sendGlobalParam(key, value) {
    if (!appState) return;
    appState.globals[key] = value;
    sendWs({ type: 'global_param', key, value });
  }

  function connectWs() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      wsDot.classList.add('online');
      setReadout('Terhubung ke DM Audio DSP Engine');
    });

    ws.addEventListener('close', () => {
      wsDot.classList.remove('online');
      setReadout('Koneksi terputus · mencoba reconnect...');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWs, 1200);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'init') {
        appState = msg.state;
        devices = msg.devices || [];
        audioStatus = msg.audioStatus || audioStatus;
        lanUrls = msg.lanUrls || [];
        selectedChannel = clamp(appState?.selectedChannel ?? 0, 0, 7);
        syncDomAll();
      } else if (msg.type === 'full_state') {
        appState = msg.state;
        selectedChannel = clamp(appState?.selectedChannel ?? selectedChannel, 0, 7);
        syncDomAll();
      } else if (msg.type === 'devices') {
        devices = msg.devices || [];
        populateDeviceSelects();
      } else if (msg.type === 'audio_status') {
        audioStatus = msg.status || audioStatus;
        updateAudioBadge();
      } else if (msg.type === 'ch_update' && appState?.channels[msg.index]) {
        appState.channels[msg.index][msg.key] = msg.value;
        if (msg.index === selectedChannel && !fatPanel.classList.contains('is-collapsed')) {
          renderFatInspector();
        }
      } else if (msg.type === 'global_update' && appState?.globals) {
        appState.globals[msg.key] = msg.value;
        updateHeaderGlobals();
      } else if (msg.type === 'selected_channel') {
        selectedChannel = clamp(msg.index ?? 0, 0, 7);
        if (!fatPanel.classList.contains('is-collapsed')) {
          renderFatInspector();
        }
      } else if (msg.type === 'pad_hit') {
        flashingPads.set(msg.index, performance.now() + 260);
        renderPadsDock();
      } else if (msg.type === 'meters' && msg.meters) {
        const m = msg.meters;
        if (Array.isArray(m.ch)) {
          for (let i = 0; i < Math.min(8, m.ch.length); i++) {
            targetMeters.ch[i].l = m.ch[i][0] ?? -96;
            targetMeters.ch[i].r = m.ch[i][1] ?? -96;
            targetMeters.ch[i].gr = m.ch[i][2] ?? 0;
          }
        }
        if (Array.isArray(m.stream)) targetMeters.stream = m.stream;
        if (Array.isArray(m.monitor)) targetMeters.monitor = m.monitor;
        if (typeof m.duckDb === 'number') targetMeters.duckDb = m.duckDb;
      }
    });
  }

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: 'ping', ts: Date.now() });
    }
  }, 15000);

  function setReadout(text) {
    if (statusReadout) statusReadout.textContent = text;
  }

  function syncDomAll() {
    updateAudioBadge();
    updateHeaderGlobals();
    populateDeviceSelects();
    renderPadsDock();
    renderLanList();
    if (!fatPanel.classList.contains('is-collapsed')) {
      renderFatInspector();
    }
  }

  function updateAudioBadge() {
    audioSetupBtn.classList.toggle('is-running', Boolean(audioStatus.running));
    audioStatusLabel.textContent = audioStatus.text || (audioStatus.running ? 'Audio Active' : 'Audio Offline');
  }

  function updateHeaderGlobals() {
    if (!appState) return;
    const g = appState.globals || {};
    const activeScene = appState.activeSceneId;
    sceneBar.querySelectorAll('.scene-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scene === activeScene);
    });

    bgmTrackLabel.textContent = appState.bgm?.trackName || 'Belum ada lagu';
    bgmPlayBtn.textContent = g.bgmPlaying ? '❚❚' : '▶';
    bgmPlayBtn.classList.toggle('is-playing', Boolean(g.bgmPlaying));
    bgmLoopBtn.classList.toggle('is-on', Boolean(g.bgmLoop));

    autoDuckBtn.classList.toggle('is-on', Boolean(g.autoDuckEnabled));
    const duckVal = Math.abs(dispMeters.duckDb) > 0.3
      ? `${dispMeters.duckDb.toFixed(1)} dB`
      : g.autoDuckEnabled ? 'ARM' : 'OFF';
    duckDbBadge.textContent = duckVal;
    renderUserPresets();
  }

  function renderUserPresets() {
    if (!appState || !presetSelect) return;
    const presets = Array.isArray(appState.userPresets) ? appState.userPresets : [];
    const activeId = appState.activeSceneId || '';

    presetSelect.innerHTML = '';
    const headOpt = document.createElement('option');
    headOpt.value = '';
    headOpt.textContent = presets.length ? `Preset User (${presets.length})` : 'Preset User...';
    presetSelect.appendChild(headOpt);

    presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === activeId) opt.selected = true;
      presetSelect.appendChild(opt);
    });

    if (!presetList) return;
    presetList.innerHTML = '';
    if (presets.length === 0) {
      const li = document.createElement('li');
      li.style.color = '#94a3b8';
      li.textContent = 'Belum ada preset tersimpan. Ketik nama di atas lalu klik Simpan Preset.';
      presetList.appendChild(li);
      return;
    }

    presets.forEach((p) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name + (p.id === activeId ? ' (Aktif)' : '');

      const actions = document.createElement('div');
      actions.className = 'dsp-pill-group';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'tb-btn tb-primary';
      loadBtn.textContent = 'Pakai';
      loadBtn.addEventListener('click', () => {
        sendWs({ type: 'recall_preset', presetId: p.id });
        presetDialog?.close();
        setReadout(`Preset dimuat: ${p.name}`);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tb-btn tb-danger';
      delBtn.textContent = 'Hapus';
      delBtn.addEventListener('click', () => {
        sendWs({ type: 'delete_preset', presetId: p.id });
        setReadout(`Preset dihapus: ${p.name}`);
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      li.appendChild(nameSpan);
      li.appendChild(actions);
      presetList.appendChild(li);
    });
  }

  function updateAudioHardwareMeta() {
    if (!audioHwMeta || !selSampleRate) return;
    const findDev = (id, isIn) => {
      if (!id || id === 'default') {
        return devices.find((d) => (isIn ? d.defIn : d.defOut)) || devices[0];
      }
      return devices.find((d) => d.id === id);
    };

    const inDev = findDev(selInputDev.value, true);
    const outDev = findDev(selMonDev.value, false);
    const refDev = inDev || outDev;
    const rateSet = new Set([44100, 48000, 88200, 96000]);
    if (inDev?.sampleRates) inDev.sampleRates.forEach((r) => rateSet.add(r));
    if (outDev?.sampleRates) outDev.sampleRates.forEach((r) => rateSet.add(r));

    const prevSr = selSampleRate.value || String(appState?.audioConfig?.sampleRate || 0);
    selSampleRate.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = '0';
    const liveSr = Math.round(audioStatus?.sampleRate || refDev?.sampleRate || 48000);
    autoOpt.textContent = `Auto (Ikuti Device · ${liveSr} Hz)`;
    selSampleRate.appendChild(autoOpt);

    Array.from(rateSet)
      .sort((a, b) => a - b)
      .forEach((rate) => {
        const opt = document.createElement('option');
        opt.value = String(rate);
        const inOk = !inDev?.sampleRates?.length || inDev.sampleRates.includes(rate);
        const outOk = !outDev?.sampleRates?.length || outDev.sampleRates.includes(rate);
        const tag = inOk && outOk ? ' · Didukung Hardware' : '';
        opt.textContent = `${rate} Hz${tag}`;
        selSampleRate.appendChild(opt);
      });
    selSampleRate.value = Array.from(selSampleRate.options).some((o) => o.value === prevSr) ? prevSr : '0';

    const drv = refDev?.driver || 'CoreAudio/WASAPI';
    const inRatesText = inDev?.sampleRates?.length ? `${inDev.sampleRates.join('/')} Hz` : `${inDev?.sampleRate || liveSr} Hz`;
    const outRatesText = outDev?.sampleRates?.length ? `${outDev.sampleRates.join('/')} Hz` : `${outDev?.sampleRate || liveSr} Hz`;
    audioHwMeta.textContent = `Driver: ${drv} · Aktif: ${liveSr} Hz | Mic: ${inDev?.name || '-'} (${inRatesText}) | Monitor: ${outDev?.name || '-'} (${outRatesText})`;
  }

  function shortDeviceName(id, fallback) {
    if (!id) return fallback;
    const found = devices.find((d) => d.id === id);
    if (!found) return fallback;
    return found.name;
  }

  function populateDeviceSelects() {
    const inputs = devices.filter((d) => d.in > 0);
    const outputs = devices.filter((d) => d.out > 0);
    const cfg = appState?.audioConfig || {};

    const fill = (sel, list, current, emptyLabel) => {
      const prev = current || sel.value;
      sel.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = emptyLabel;
      sel.appendChild(defOpt);
      for (const dev of list) {
        const opt = document.createElement('option');
        opt.value = dev.id;
        const srTag = dev.sampleRate ? ` · ${Math.round(dev.sampleRate)}Hz` : '';
        opt.textContent = `${dev.name} (${dev.in}in/${dev.out}out${srTag})`;
        if (dev.id === prev) opt.selected = true;
        sel.appendChild(opt);
      }
    };

    fill(selInputDev, inputs, cfg.inputDevId, 'Default System Mic');
    fill(selMusicInputDev, inputs, cfg.musicInputDevId, 'Tidak dipakai / BGM Internal');
    fill(selMonDev, outputs, cfg.monitorOutDevId, 'Default Speakers / Headphones');
    fill(selStreamDev, outputs, cfg.streamOutDevId, 'Virtual Cable (OBS / TikTok Live)');
    if (cfg.bufferSize) selBufSize.value = String(cfg.bufferSize);
    if (selSampleRate && cfg.sampleRate !== undefined) {
      selSampleRate.value = String(cfg.sampleRate || 0);
    }
    updateAudioHardwareMeta();
  }

  function renderLanList() {
    lanList.innerHTML = '';
    const urls = lanUrls.length ? lanUrls : [window.location.origin];
    urls.forEach((url) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = url;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'tb-btn';
      copyBtn.textContent = 'Salin';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(url);
        copyBtn.textContent = 'Disalin';
        setTimeout(() => (copyBtn.textContent = 'Salin'), 1200);
      });
      li.appendChild(span);
      li.appendChild(copyBtn);
      lanList.appendChild(li);
    });
  }

  function renderPadsDock() {
    if (!appState) return;
    const now = performance.now();
    padsRow.innerHTML = '';
    (appState.pads || []).slice(0, 8).forEach((pad, idx) => {
      const tile = document.createElement('div');
      tile.className = 'pad-tile';
      if ((flashingPads.get(idx) || 0) > now) {
        tile.classList.add('is-firing');
      }

      const top = document.createElement('div');
      top.className = 'pad-tile-top';
      const numSpan = document.createElement('span');
      numSpan.textContent = `PAD ${idx + 1}`;
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'pad-upload-btn';
      upBtn.textContent = 'Upload';
      upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingPadUpload = idx;
        wavUploadInput.value = '';
        wavUploadInput.click();
      });
      top.appendChild(numSpan);
      top.appendChild(upBtn);

      const nameEl = document.createElement('div');
      nameEl.className = 'pad-tile-name';
      nameEl.textContent = pad.name || `Pad ${idx + 1}`;

      tile.appendChild(top);
      tile.appendChild(nameEl);
      tile.addEventListener('click', () => {
        sendWs({ type: 'pad_trigger', index: idx });
        flashingPads.set(idx, performance.now() + 260);
        tile.classList.add('is-firing');
        setReadout(`Soundboard Pad ${idx + 1}: ${pad.name}`);
      });

      padsRow.appendChild(tile);
    });
  }

  function renderFatInspector() {
    if (!appState) return;
    const ch = appState.channels[selectedChannel];
    if (!ch) return;
    fatChannelName.textContent = `Ch ${selectedChannel + 1} · ${ch.name}`;
    fatBody.innerHTML = '';

    // 1. Identity & Input Routing
    const cardId = document.createElement('div');
    cardId.className = 'dsp-card';
    cardId.innerHTML = `<div class="dsp-card-head"><span>Channel &amp; Input Patch</span></div>`;

    const nameRow = document.createElement('label');
    nameRow.className = 'dsp-row';
    nameRow.innerHTML = `<span>Nama Channel</span>`;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 18;
    nameInput.value = ch.name;
    nameInput.addEventListener('change', () => {
      const next = nameInput.value.trim() || ch.name;
      ch.name = next;
      sendWs({ type: 'rename_channel', index: selectedChannel, name: next });
      fatChannelName.textContent = `Ch ${selectedChannel + 1} · ${next}`;
    });
    nameRow.appendChild(nameInput);
    cardId.appendChild(nameRow);

    if (selectedChannel < 6) {
      const srcRow = document.createElement('label');
      srcRow.className = 'dsp-row';
      srcRow.innerHTML = `<span>Sumber Perangkat</span>`;
      const srcSel = document.createElement('select');
      [
        [0, 'Hardware Mic / Audio Interface'],
        [2, 'System Loopback (Discord / Game / Browser)'],
      ].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = String(val);
        opt.textContent = label;
        if (Number(ch.sourceMode) === val) opt.selected = true;
        srcSel.appendChild(opt);
      });
      srcSel.addEventListener('change', () => {
        sendChParam(selectedChannel, 'sourceMode', Number(srcSel.value));
      });
      srcRow.appendChild(srcSel);
      cardId.appendChild(srcRow);

      const modeRow = document.createElement('label');
      modeRow.className = 'dsp-row';
      modeRow.innerHTML = `<span>Mode Input Kanal</span>`;
      const modeSel = document.createElement('select');
      [
        ['0', 'MONO (1 kanal tunggal — aman buat Mic 1/2)'],
        ['1', 'STEREO (2 kanal berpasangan L+R)'],
      ].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if ((ch.stereoInput ? '1' : '0') === val) opt.selected = true;
        modeSel.appendChild(opt);
      });
      modeSel.addEventListener('change', () => {
        sendChParam(selectedChannel, 'stereoInput', modeSel.value === '1');
      });
      modeRow.appendChild(modeSel);
      cardId.appendChild(modeRow);

      const offRow = document.createElement('label');
      offRow.className = 'dsp-row';
      offRow.innerHTML = `<span>Hardware Input Slot</span>`;
      const offSel = document.createElement('select');
      for (let slot = 0; slot < 8; slot++) {
        const opt = document.createElement('option');
        opt.value = String(slot);
        const prefix = Number(ch.sourceMode) === 2 ? 'Loopback' : 'Hw Interface';
        opt.textContent = ch.stereoInput
          ? `${prefix} Stereo ${slot + 1}-${slot + 2}`
          : `${prefix} Mono In ${slot + 1}`;
        if ((ch.inputChannelOffset || 0) === slot) opt.selected = true;
        offSel.appendChild(opt);
      }
      offSel.addEventListener('change', () => {
        sendChParam(selectedChannel, 'inputChannelOffset', Number(offSel.value));
      });
      offRow.appendChild(offSel);
      cardId.appendChild(offRow);
    }

    const duckRow = document.createElement('label');
    duckRow.className = 'dsp-row';
    duckRow.innerHTML = `<span>Auto-Ducking Role</span>`;
    const duckSel = document.createElement('select');
    [
      [0, 'Normal (Tidak terpengaruh)'],
      [1, 'Host / Trigger (Menurunkan musik)'],
      [2, 'Musik / Target (Otomatis pelan saat Host bicara)'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = String(val);
      opt.textContent = label;
      if (Number(ch.duckRole || 0) === val) opt.selected = true;
      duckSel.appendChild(opt);
    });
    duckSel.addEventListener('change', () => {
      sendChParam(selectedChannel, 'duckRole', Number(duckSel.value));
    });
    duckRow.appendChild(duckSel);
    cardId.appendChild(duckRow);

    const pills = document.createElement('div');
    pills.className = 'dsp-pill-group';
    const makeFlagBtn = (label, key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tb-btn ${ch[key] ? 'is-on' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => {
        sendChParam(selectedChannel, key, !ch[key]);
        renderFatInspector();
      });
      return b;
    };
    pills.appendChild(makeFlagBtn('Ø Phase', 'phaseInvert'));
    pills.appendChild(makeFlagBtn('OBS Stream', 'routeStream'));
    pills.appendChild(makeFlagBtn('Monitor HP', 'routeMonitor'));
    pills.appendChild(makeFlagBtn('Tone 1kHz', 'testTone'));
    cardId.appendChild(pills);
    fatBody.appendChild(cardId);

    // 2. HPF & Noise Gate
    const cardGate = document.createElement('div');
    cardGate.className = 'dsp-card';
    const gateHead = document.createElement('div');
    gateHead.className = 'dsp-card-head';
    gateHead.innerHTML = `<span>HPF &amp; Noise Gate</span>`;
    const hpfBtn = makeFlagBtn(ch.hpfOn ? 'HPF ON' : 'HPF OFF', 'hpfOn');
    const gateBtn = makeFlagBtn(ch.gateOn ? 'GATE ON' : 'GATE OFF', 'gateOn');
    const gateTogs = document.createElement('div');
    gateTogs.className = 'dsp-pill-group';
    gateTogs.appendChild(hpfBtn);
    gateTogs.appendChild(gateBtn);
    gateHead.appendChild(gateTogs);
    cardGate.appendChild(gateHead);

    cardGate.appendChild(makeSliderRow('HPF Cutoff', ch.hpfHz ?? 80, 20, 250, 5, 'Hz', (val) => {
      sendChParam(selectedChannel, 'hpfHz', val);
    }));
    cardGate.appendChild(makeSliderRow('Gate Threshold', ch.gateThreshDb ?? -50, -80, -10, 1, 'dB', (val) => {
      sendChParam(selectedChannel, 'gateThreshDb', val);
    }));
    fatBody.appendChild(cardGate);

    // 3. Compressor & EQ Mid Freq
    const cardComp = document.createElement('div');
    cardComp.className = 'dsp-card';
    const compHead = document.createElement('div');
    compHead.className = 'dsp-card-head';
    compHead.innerHTML = `<span>Compressor &amp; Swept Mid</span>`;
    const compBtn = makeFlagBtn(ch.compOn ? 'COMP ON' : 'COMP OFF', 'compOn');
    compHead.appendChild(compBtn);
    cardComp.appendChild(compHead);

    cardComp.appendChild(makeSliderRow('Comp Threshold', ch.compThreshDb ?? -18, -45, 0, 1, 'dB', (val) => {
      sendChParam(selectedChannel, 'compThreshDb', val);
    }));
    cardComp.appendChild(makeSliderRow('Comp Ratio', ch.compRatio ?? 3.0, 1.0, 10.0, 0.2, ':1', (val) => {
      sendChParam(selectedChannel, 'compRatio', val);
    }));
    cardComp.appendChild(makeSliderRow('Comp Makeup', ch.compMakeupDb ?? 2.0, 0, 15, 0.5, 'dB', (val) => {
      sendChParam(selectedChannel, 'compMakeupDb', val);
    }));
    cardComp.appendChild(makeSliderRow('EQ Mid Freq', ch.eqMidHz ?? 1200, 150, 3500, 25, 'Hz', (val) => {
      sendChParam(selectedChannel, 'eqMidHz', val);
    }));
    fatBody.appendChild(cardComp);

    // 4. Built-in Insert Rack (Slot A & Slot B)
    const INSERT_SPECS = [
      { id: 0, name: 'Kosong (Bypass)', p1: null, p2: null },
      { id: 1, name: 'De-Esser (Desis S)', p1: 'Freq (4.5-9k)', p2: 'Reduction' },
      { id: 2, name: 'Vocal Warmth (Tube)', p1: 'Warmth Drive', p2: 'Air Presence' },
      { id: 3, name: 'Stereo Delay / Echo', p1: 'Delay Time', p2: 'Feedback & Mix' },
      { id: 4, name: 'Voice FX (Radio/Telp)', p1: 'Radio/Telp/Mega', p2: 'FX Drive' },
    ];

    const renderInsertSlot = (slotLabel, keyKind, keyP1, keyP2) => {
      const card = document.createElement('div');
      card.className = 'dsp-card';
      const curKind = Number(ch[keyKind] || 0);
      const spec = INSERT_SPECS.find((s) => s.id === curKind) || INSERT_SPECS[0];

      const row = document.createElement('label');
      row.className = 'dsp-row';
      row.innerHTML = `<span style="color:#a7f3d0;font-weight:700;">${slotLabel}</span>`;
      const sel = document.createElement('select');
      INSERT_SPECS.forEach((optSpec) => {
        const opt = document.createElement('option');
        opt.value = String(optSpec.id);
        opt.textContent = optSpec.name;
        if (optSpec.id === curKind) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        sendChParam(selectedChannel, keyKind, Number(sel.value));
        renderFatInspector();
      });
      row.appendChild(sel);
      card.appendChild(row);

      if (spec.p1) {
        card.appendChild(
          makeSliderRow(spec.p1, Math.round((ch[keyP1] ?? 0.5) * 100), 0, 100, 1, '%', (val) => {
            sendChParam(selectedChannel, keyP1, Number((val / 100).toFixed(2)));
          })
        );
      }
      if (spec.p2) {
        card.appendChild(
          makeSliderRow(spec.p2, Math.round((ch[keyP2] ?? 0.5) * 100), 0, 100, 1, '%', (val) => {
            sendChParam(selectedChannel, keyP2, Number((val / 100).toFixed(2)));
          })
        );
      }
      fatBody.appendChild(card);
    };

    renderInsertSlot('Insert Slot A (Built-in)', 'insertA', 'insertAParam1', 'insertAParam2');
    renderInsertSlot('Insert Slot B (Built-in)', 'insertB', 'insertBParam1', 'insertBParam2');

    // 5. Master OBS Broadcast Limiter
    const g = appState.globals || {};
    const cardLim = document.createElement('div');
    cardLim.className = 'dsp-card';
    const limHead = document.createElement('div');
    limHead.className = 'dsp-card-head';
    limHead.innerHTML = `<span>Master OBS Limiter</span>`;
    const limBtn = document.createElement('button');
    limBtn.type = 'button';
    limBtn.className = `tb-btn ${g.masterLimiterOn !== false ? 'is-on' : ''}`;
    limBtn.textContent = g.masterLimiterOn !== false ? 'LIMITER ON' : 'BYPASS';
    limBtn.addEventListener('click', () => {
      sendGlobalParam('masterLimiterOn', !(g.masterLimiterOn !== false));
      renderFatInspector();
    });
    limHead.appendChild(limBtn);
    cardLim.appendChild(limHead);

    cardLim.appendChild(makeSliderRow('Loudness Drive', g.masterLimiterDriveDb ?? 2.0, 0, 12, 0.5, 'dB', (val) => {
      sendGlobalParam('masterLimiterDriveDb', val);
    }));
    cardLim.appendChild(makeSliderRow('Output Ceiling', g.masterLimiterCeilingDb ?? -1.0, -6.0, -0.1, 0.1, 'dBFS', (val) => {
      sendGlobalParam('masterLimiterCeilingDb', val);
    }));
    fatBody.appendChild(cardLim);
  }

  function makeSliderRow(label, initialVal, min, max, step, unit, onChange) {
    const row = document.createElement('label');
    row.className = 'dsp-row';
    const top = document.createElement('div');
    top.className = 'dsp-row-inline';
    const lblSpan = document.createElement('span');
    lblSpan.textContent = label;
    const valSpan = document.createElement('strong');
    valSpan.style.color = '#7dd3fc';
    valSpan.textContent = `${Number(initialVal).toFixed(step < 1 ? 1 : 0)} ${unit}`;
    top.appendChild(lblSpan);
    top.appendChild(valSpan);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initialVal);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      valSpan.textContent = `${v.toFixed(step < 1 ? 1 : 0)} ${unit}`;
      onChange(v);
    });

    row.appendChild(top);
    row.appendChild(input);
    return row;
  }

  // Decode WAV/MP3/M4A/OGG/FLAC into stereo 48kHz 16-bit PCM WAV Buffer
  async function decodeAudioFileToWavBuffer(file) {
    const arrayBuf = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const decCtx = new AudioCtx();
    try {
      const decoded = await decCtx.decodeAudioData(arrayBuf.slice(0));
      const targetSr = 48000;
      const frameCount = Math.max(1, Math.ceil(decoded.duration * targetSr));
      const offCtx = new OfflineAudioContext(2, frameCount, targetSr);
      const src = offCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(offCtx.destination);
      src.start(0);
      const rendered = await offCtx.startRendering();

      const chL = rendered.getChannelData(0);
      const chR = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : chL;
      const numFrames = rendered.length;
      const dataBytes = numFrames * 4;
      const wavBuf = new ArrayBuffer(44 + dataBytes);
      const view = new DataView(wavBuf);

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
      view.setUint32(24, targetSr, true);
      view.setUint32(28, targetSr * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataBytes, true);

      let offset = 44;
      for (let i = 0; i < numFrames; i++) {
        const sL = clamp(chL[i], -1, 1);
        const sR = clamp(chR[i], -1, 1);
        view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
        view.setInt16(offset + 2, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
        offset += 4;
      }
      return wavBuf;
    } finally {
      await decCtx.close().catch(() => {});
    }
  }

  // Canvas Responsive Sizing
  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const aspect = LOGICAL_W / LOGICAL_H;
    let w = rect.width;
    let h = rect.height;

    if (window.innerWidth <= 900) {
      // Allow comfortable minimum size with horizontal scroll on narrow mobile screens
      h = Math.max(480, rect.height);
      w = h * aspect;
    } else if (w / h > aspect) {
      w = h * aspect;
    } else {
      h = w / aspect;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${Math.floor(w)}px`;
    canvas.style.height = `${Math.floor(h)}px`;
    canvas.width = Math.round(LOGICAL_W * dpr);
    canvas.height = Math.round(LOGICAL_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Drawing Helpers
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPillButton(opts) {
    const {
      x, y, w, h, text, active, activeBg = '#0284c7', activeBorder = '#38bdf8',
      activeText = '#ffffff', offBg = '#222832', offBorder = '#353e4c', offText = '#94a3b8',
      fontSize = 8.5, controlId, label, onClick,
    } = opts;

    interactiveControls.push({ type: 'button', id: controlId, x, y, w, h, label, onClick });

    ctx.save();
    roundRect(x, y, w, h, 4);
    ctx.fillStyle = active ? activeBg : offBg;
    if (active) {
      ctx.shadowColor = activeBorder;
      ctx.shadowBlur = 7;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = hoveredControl === controlId ? '#ffffff' : (active ? activeBorder : offBorder);
    ctx.stroke();

    ctx.fillStyle = active ? activeText : offText;
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.restore();
  }

  function drawToggleButton(opts) {
    const { x, y, w, h, active, activeColor, offColor = '#272d35', controlId, onClick, label } = opts;
    interactiveControls.push({ type: 'button', id: controlId, x, y, w, h, onClick, label });

    ctx.save();
    roundRect(x, y, w, h, 4);
    ctx.fillStyle = active ? activeColor : offColor;
    if (active) {
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = 10;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = hoveredControl === controlId ? '#ffffff' : 'rgba(255,255,255,0.16)';
    ctx.stroke();
    ctx.restore();
  }

  function drawKnob(opts) {
    const {
      cx, cy, radius = 15, value, color, label, leftLbl, rightLbl, topLbl,
      isBipolar = false, resetVal = isBipolar ? 0.5 : 0.0,
      controlId, onChange, formatText,
    } = opts;

    interactiveControls.push({
      type: 'knob',
      id: controlId,
      x: cx - radius - 8,
      y: cy - radius - 14,
      w: (radius + 8) * 2,
      h: (radius + 14) * 2,
      value,
      resetVal,
      label,
      onChange,
      formatText,
    });

    ctx.save();
    ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#cbd5e1';
    if (label) ctx.fillText(label, cx, cy - radius - 6);

    ctx.font = '600 7.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    if (topLbl) ctx.fillText(topLbl, cx, cy - radius - 1);
    if (leftLbl) {
      ctx.textAlign = 'right';
      ctx.fillText(leftLbl, cx - radius + 3, cy + radius + 9);
    }
    if (rightLbl) {
      ctx.textAlign = 'left';
      ctx.fillText(rightLbl, cx + radius - 3, cy + radius + 9);
    }

    const startAng = Math.PI * 0.75;
    const endAng = Math.PI * 2.25;
    const v = clamp(value, 0, 1);
    const curAng = startAng + v * (endAng - startAng);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 3, startAng, endAng);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Glowing LED collar arc
    ctx.beginPath();
    if (isBipolar) {
      const midAng = Math.PI * 1.5;
      ctx.arc(cx, cy, radius + 3, Math.min(midAng, curAng), Math.max(midAng, curAng));
    } else {
      ctx.arc(cx, cy, radius + 3, startAng, curAng);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 3D Knob Body
    const grad = ctx.createRadialGradient(cx - 4, cy - 4, 2, cx, cy, radius);
    grad.addColorStop(0, '#3f4752');
    grad.addColorStop(0.7, '#1e2329');
    grad.addColorStop(1, '#111418');

    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = hoveredControl === controlId ? '#38bdf8' : '#090b0d';
    ctx.stroke();

    // Inner color ring
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(4, radius - 5), 0, Math.PI * 2);
    ctx.fillStyle = '#181c22';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();

    // White pointer line
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(curAng) * 3, cy + Math.sin(curAng) * 3);
    ctx.lineTo(cx + Math.cos(curAng) * (radius - 2), cy + Math.sin(curAng) * (radius - 2));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  function drawFader(opts) {
    const {
      cx, topY, height, value, capColor, controlId, label,
      resetVal = 0.75, onChange, formatText, meterNorm = 0, showMeter = false,
    } = opts;

    const capW = 28;
    const capH = 42;
    const travel = height - capH;
    const v = clamp(value, 0, 1);
    const capY = topY + (1 - v) * travel;

    interactiveControls.push({
      type: 'fader',
      id: controlId,
      x: cx - 22,
      y: topY - 8,
      w: 44,
      h: height + 16,
      topY: topY + capH / 2,
      travel,
      value: v,
      resetVal,
      label,
      onChange,
      formatText,
    });

    ctx.save();

    // Optional mini LED meter strip to the left of the fader track
    if (showMeter) {
      const mx = cx - 28;
      const my = topY + 6;
      const mh = height - 12;
      roundRect(mx, my, 7, mh, 3);
      ctx.fillStyle = '#07090c';
      ctx.fill();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1;
      ctx.stroke();

      const fillH = mh * clamp(meterNorm, 0, 1);
      if (fillH > 1.5) {
        const mGrad = ctx.createLinearGradient(0, my + mh, 0, my);
        mGrad.addColorStop(0, '#22c55e');
        mGrad.addColorStop(0.72, '#facc15');
        mGrad.addColorStop(0.92, '#ef4444');
        roundRect(mx + 1, my + mh - fillH, 5, fillH, 2);
        ctx.fillStyle = mGrad;
        ctx.fill();
      }
    }

    // dB Scale ticks on the right of fader track
    const dbMarks = [
      { pos: 0.04, txt: '10' },
      { pos: 0.14, txt: '5' },
      { pos: 0.25, txt: '0' },
      { pos: 0.37, txt: '5' },
      { pos: 0.49, txt: '10' },
      { pos: 0.61, txt: '15' },
      { pos: 0.72, txt: '20' },
      { pos: 0.82, txt: '30' },
      { pos: 0.90, txt: '40' },
      { pos: 0.95, txt: '50' },
      { pos: 0.99, txt: '∞' },
    ];

    ctx.font = '600 7.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    dbMarks.forEach((m) => {
      const my = topY + m.pos * height;
      ctx.strokeStyle = m.txt === '0' ? '#38bdf8' : '#475569';
      ctx.lineWidth = m.txt === '0' ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + 8, my);
      ctx.lineTo(cx + 15, my);
      ctx.stroke();

      ctx.fillStyle = m.txt === '0' ? '#38bdf8' : '#94a3b8';
      ctx.fillText(m.txt, cx + 17, my);
    });

    // Track slot
    roundRect(cx - 4, topY, 8, height, 4);
    ctx.fillStyle = '#050709';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#27303f';
    ctx.stroke();

    // Fader cap drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(cx - capW / 2 + 2, capY + 4, capW, capH, 6);
    ctx.fill();

    // 3D Sculpted Fader Cap
    const capGrad = ctx.createLinearGradient(0, capY, 0, capY + capH);
    if (capColor === 'white') {
      capGrad.addColorStop(0, '#f8fafc');
      capGrad.addColorStop(0.45, '#cbd5e1');
      capGrad.addColorStop(0.55, '#94a3b8');
      capGrad.addColorStop(1, '#e2e8f0');
    } else if (capColor === 'green') {
      capGrad.addColorStop(0, '#34d399');
      capGrad.addColorStop(0.45, '#059669');
      capGrad.addColorStop(0.55, '#047857');
      capGrad.addColorStop(1, '#10b981');
    } else {
      capGrad.addColorStop(0, '#f87171');
      capGrad.addColorStop(0.45, '#dc2626');
      capGrad.addColorStop(0.55, '#991b1b');
      capGrad.addColorStop(1, '#ef4444');
    }

    roundRect(cx - capW / 2, capY, capW, capH, 6);
    ctx.fillStyle = capGrad;
    ctx.fill();
    ctx.lineWidth = hoveredControl === controlId ? 2 : 1;
    ctx.strokeStyle = hoveredControl === controlId ? '#38bdf8' : '#0f172a';
    ctx.stroke();

    // Cap center pointer line
    ctx.fillStyle = capColor === 'white' ? '#0f172a' : '#ffffff';
    ctx.fillRect(cx - capW / 2 + 2, capY + capH / 2 - 1.5, capW - 4, 3);
    ctx.restore();
  }

  function truncateText(text, maxChars) {
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  function renderMixer() {
    interactiveControls = [];
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    // 1. Main Charcoal/Zinc Chassis
    const bodyGrad = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
    bodyGrad.addColorStop(0, '#1e2228');
    bodyGrad.addColorStop(0.06, '#15181d');
    bodyGrad.addColorStop(0.94, '#121519');
    bodyGrad.addColorStop(1, '#0c0e12');

    roundRect(4, 4, LOGICAL_W - 8, LOGICAL_H - 8, 20);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#333a45';
    ctx.stroke();

    // Side rubber bumpers
    ctx.fillStyle = '#0d0f12';
    roundRect(4, 32, 11, LOGICAL_H - 64, 5);
    ctx.fill();
    roundRect(LOGICAL_W - 15, 32, 11, LOGICAL_H - 64, 5);
    ctx.fill();

    if (!appState) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 15px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Menghubungkan ke DM Audio DSP Engine...', LOGICAL_W / 2, LOGICAL_H / 2);
      return;
    }

    const g = appState.globals || {};
    const anySolo = appState.channels.some((c) => c.solo);

    // 2. Render 8 Channel Strips (0..5 Mono White, 6..7 Stereo Green)
    for (let i = 0; i < 8; i++) {
      const ch = appState.channels[i];
      const isGreen = i >= 6;
      const colW = isGreen ? 114 : 122;
      const x = isGreen ? 782 + (i - 6) * 118 : 22 + i * 126;
      const cx = x + colW / 2;
      const isSelected = i === selectedChannel;

      // Upper Strip Container
      roundRect(x, 16, colW, 420, 8);
      ctx.fillStyle = '#191d23';
      ctx.fill();
      if (isSelected) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.stroke();
      }

      // Header Channel Badge (Click to select & rename / open DSP)
      roundRect(x + 3, 19, colW - 6, 22, 4);
      ctx.fillStyle = isSelected ? '#1f2d3d' : '#262c35';
      ctx.fill();

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '700 10px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const numLabel = i === 6 ? '7-8' : i === 7 ? '9-10' : `${i + 1}`;
      ctx.fillText(numLabel, x + 8, 30);
      ctx.textAlign = 'right';
      ctx.fillStyle = isSelected ? '#7dd3fc' : '#cbd5e1';
      ctx.fillText(truncateText(ch.name, 11), x + colW - 8, 30);

      interactiveControls.push({
        type: 'button',
        id: `hdr_${i}`,
        x: x + 3,
        y: 19,
        w: colW - 6,
        h: 22,
        label: `Pilih Ch ${numLabel} (${ch.name})`,
        onClick: () => {
          selectedChannel = i;
          sendWs({ type: 'select_channel', index: i });
          renderFatInspector();
        },
      });

      // Condensed Top Input Source Selector Pill (DAW-style Patch + Mono/Stereo)
      let srcText = 'HW 1 · MONO';
      let srcActive = Number(ch.sourceMode) === 0;
      if (i < 6) {
        const slot = (ch.inputChannelOffset || 0) + 1;
        const srcPrefix = Number(ch.sourceMode) === 2 ? 'LOOP' : 'HW';
        const isSt = ch.stereoInput !== false;
        srcText = isSt ? `${srcPrefix} ${slot}-${slot + 1} · ST` : `${srcPrefix} ${slot} · MONO`;
        srcActive = Number(ch.sourceMode) === 0;
      } else if (i === 6) {
        srcText = g.bgmPlaying ? 'BGM PLAY ▶' : 'BGM DECK ▾';
        srcActive = Boolean(g.bgmPlaying);
      } else {
        srcText = 'PADS x8 ▾';
        srcActive = !soundboardDock.classList.contains('is-collapsed');
      }

      drawPillButton({
        x: x + 5,
        y: 45,
        w: colW - 10,
        h: 19,
        text: srcText,
        active: srcActive,
        activeBg: isGreen ? '#065f46' : '#1e3a5f',
        activeBorder: isGreen ? '#10b981' : '#38bdf8',
        activeText: isGreen ? '#a7f3d0' : '#7dd3fc',
        offBg: '#232932',
        offText: '#cbd5e1',
        fontSize: 8.2,
        controlId: `src_${i}`,
        label: `Patch Input Ch ${numLabel}`,
        onClick: () => {
          if (i < 6) {
            const step = ch.stereoInput !== false ? 2 : 1;
            const nextOffset = ((ch.inputChannelOffset || 0) + step) % 8;
            sendChParam(i, 'inputChannelOffset', nextOffset);
          } else if (i === 6) {
            if (!appState.bgm?.trackName) {
              bgmUploadInput.click();
            } else {
              sendGlobalParam('bgmPlaying', !g.bgmPlaying);
            }
          } else {
            soundboardDock.classList.toggle('is-collapsed');
            togglePadsBtn.classList.toggle('is-active', !soundboardDock.classList.contains('is-collapsed'));
            resizeCanvas();
          }
        },
      });

      // Bus Routing & DSP Mini-Pills: [OBS] [MON] [DSP]
      const pillW = Math.floor((colW - 14) / 3);
      drawPillButton({
        x: x + 5,
        y: 67,
        w: pillW,
        h: 17,
        text: 'OBS',
        active: Boolean(ch.routeStream),
        activeBg: '#0369a1',
        activeBorder: '#38bdf8',
        fontSize: 7.5,
        controlId: `obs_${i}`,
        label: `${ch.name} Route OBS`,
        onClick: () => sendChParam(i, 'routeStream', !ch.routeStream),
      });
      drawPillButton({
        x: x + 7 + pillW,
        y: 67,
        w: pillW,
        h: 17,
        text: 'MON',
        active: Boolean(ch.routeMonitor),
        activeBg: '#047857',
        activeBorder: '#34d399',
        fontSize: 7.5,
        controlId: `mon_${i}`,
        label: `${ch.name} Route Monitor`,
        onClick: () => sendChParam(i, 'routeMonitor', !ch.routeMonitor),
      });
      const dspBusy = Boolean(ch.hpfOn || ch.gateOn || ch.compOn || Number(ch.insertA) > 0 || Number(ch.insertB) > 0);
      drawPillButton({
        x: x + 9 + pillW * 2,
        y: 67,
        w: pillW,
        h: 17,
        text: Number(ch.insertA) > 0 || Number(ch.insertB) > 0 ? 'INS•' : 'DSP',
        active: isSelected && !fatPanel.classList.contains('is-collapsed'),
        activeBg: '#92400e',
        activeBorder: '#f59e0b',
        activeText: '#fde68a',
        offText: dspBusy ? '#fbbf24' : '#94a3b8',
        fontSize: 7.5,
        controlId: `dsp_${i}`,
        label: `Buka DSP ${ch.name}`,
        onClick: () => {
          const already = selectedChannel === i && !fatPanel.classList.contains('is-collapsed');
          selectedChannel = i;
          sendWs({ type: 'select_channel', index: i });
          fatPanel.classList.toggle('is-collapsed', already);
          toggleFatBtn.classList.toggle('is-active', !already);
          if (!already) renderFatInspector();
          resizeCanvas();
        },
      });

      // GAIN Knob (-20..+24 dB)
      drawKnob({
        cx,
        cy: 112,
        radius: 15,
        value: clamp(((ch.trimDb ?? 0) + 20) / 44, 0, 1),
        resetVal: 20 / 44,
        color: '#38bdf8',
        label: 'gain',
        leftLbl: '-20',
        rightLbl: '+24',
        controlId: `gain_${i}`,
        onChange: (val) => {
          const db = Number((-20 + val * 44).toFixed(1));
          sendChParam(i, 'trimDb', db);
        },
        formatText: (val) => {
          const db = (-20 + val * 44).toFixed(1);
          return `${ch.name} GAIN: ${Number(db) > 0 ? '+' : ''}${db} dB`;
        },
      });

      // Signature Grey EQ Box (#474e58) 2x2 Grid
      roundRect(x + 3, 145, colW - 6, 120, 6);
      ctx.fillStyle = '#474e58';
      ctx.fill();

      const eqLeftX = x + Math.round(colW * 0.28);
      const eqRightX = x + Math.round(colW * 0.72);

      drawKnob({
        cx: eqLeftX,
        cy: 173,
        radius: 14,
        value: clamp(0.5 + (ch.eqHighDb ?? 0) / 30, 0, 1),
        isBipolar: true,
        color: '#cbd5e1',
        label: 'treble',
        leftLbl: '-15',
        rightLbl: '+15',
        controlId: `treble_${i}`,
        onChange: (val) => sendChParam(i, 'eqHighDb', Number(((val - 0.5) * 30).toFixed(1))),
        formatText: (val) => {
          const db = ((val - 0.5) * 30).toFixed(1);
          return `${ch.name} TREBLE (12k): ${Number(db) > 0 ? '+' : ''}${db} dB`;
        },
      });

      drawKnob({
        cx: eqRightX,
        cy: 173,
        radius: 14,
        value: clamp(0.5 + (ch.eqMidDb ?? 0) / 30, 0, 1),
        isBipolar: true,
        color: '#0ea5e9',
        label: 'mid',
        leftLbl: '-15',
        rightLbl: '+15',
        controlId: `mid_${i}`,
        onChange: (val) => sendChParam(i, 'eqMidDb', Number(((val - 0.5) * 30).toFixed(1))),
        formatText: (val) => {
          const db = ((val - 0.5) * 30).toFixed(1);
          return `${ch.name} MID: ${Number(db) > 0 ? '+' : ''}${db} dB`;
        },
      });

      drawKnob({
        cx: eqLeftX,
        cy: 231,
        radius: 14,
        value: eqMidHzToNorm(ch.eqMidHz ?? 1200),
        resetVal: eqMidHzToNorm(1200),
        color: '#a3e635',
        label: 'freq',
        leftLbl: '150',
        rightLbl: '3.5k',
        controlId: `freq_${i}`,
        onChange: (val) => sendChParam(i, 'eqMidHz', normToEqMidHz(val)),
        formatText: (val) => `${ch.name} MID FREQ: ${normToEqMidHz(val)} Hz`,
      });

      drawKnob({
        cx: eqRightX,
        cy: 231,
        radius: 14,
        value: clamp(0.5 + (ch.eqLowDb ?? 0) / 30, 0, 1),
        isBipolar: true,
        color: '#fb7185',
        label: 'bass',
        leftLbl: '-15',
        rightLbl: '+15',
        controlId: `bass_${i}`,
        onChange: (val) => sendChParam(i, 'eqLowDb', Number(((val - 0.5) * 30).toFixed(1))),
        formatText: (val) => {
          const db = ((val - 0.5) * 30).toFixed(1);
          return `${ch.name} BASS (80Hz): ${Number(db) > 0 ? '+' : ''}${db} dB`;
        },
      });

      // AUX 1 (Reverb Send) & AUX 2 (Compressor Drive) Side-by-Side
      drawKnob({
        cx: eqLeftX,
        cy: 298,
        radius: 14,
        value: clamp(ch.reverbSend ?? 0, 0, 1),
        resetVal: 0,
        color: '#22c55e',
        label: 'aux 1 fx',
        leftLbl: '0',
        rightLbl: '10',
        controlId: `aux1_${i}`,
        onChange: (val) => sendChParam(i, 'reverbSend', Number(val.toFixed(2))),
        formatText: (val) => `${ch.name} FX SEND: ${Math.round(val * 100)}%`,
      });

      drawKnob({
        cx: eqRightX,
        cy: 298,
        radius: 14,
        value: getCompDriveNorm(ch),
        resetVal: 0,
        color: '#22c55e',
        label: 'comp',
        leftLbl: 'off',
        rightLbl: 'max',
        controlId: `comp_${i}`,
        onChange: (val) => {
          if (val <= 0.03) {
            sendChParam(i, 'compOn', false);
          } else {
            if (!ch.compOn) sendChParam(i, 'compOn', true);
            const thresh = Math.round(-8 - val * 28);
            const ratio = Number((1.5 + val * 6.5).toFixed(1));
            sendChParam(i, 'compThreshDb', thresh);
            sendChParam(i, 'compRatio', ratio);
          }
        },
        formatText: (val) => val <= 0.03
          ? `${ch.name} COMP: OFF`
          : `${ch.name} COMP: Thresh ${Math.round(-8 - val * 28)} dB`,
      });

      // PAN / BAL Knob
      drawKnob({
        cx,
        cy: 356,
        radius: 14,
        value: clamp(0.5 + (ch.pan ?? 0) * 0.5, 0, 1),
        isBipolar: true,
        color: '#f43f5e',
        label: isGreen ? 'bal' : 'pan',
        leftLbl: 'l',
        rightLbl: 'r',
        controlId: `pan_${i}`,
        onChange: (val) => sendChParam(i, 'pan', Number(((val - 0.5) * 2).toFixed(2))),
        formatText: (val) => {
          const p = Math.round((val - 0.5) * 200);
          return `${ch.name} PAN: ${p === 0 ? 'CENTER' : p < 0 ? `L${-p}` : `R${p}`}`;
        },
      });

      // PFL (Solo), PEAK LED & MUTE Row
      drawToggleButton({
        x: x + 10,
        y: 392,
        w: 28,
        h: 16,
        active: Boolean(ch.solo),
        activeColor: '#facc15',
        offColor: '#713f12',
        controlId: `pfl_${i}`,
        label: `${ch.name} PFL Solo`,
        onClick: () => sendChParam(i, 'solo', !ch.solo),
      });

      drawToggleButton({
        x: x + colW - 38,
        y: 392,
        w: 28,
        h: 16,
        active: Boolean(ch.mute),
        activeColor: '#ef4444',
        offColor: '#7f1d1d',
        controlId: `mute_${i}`,
        label: `${ch.name} Mute`,
        onClick: () => sendChParam(i, 'mute', !ch.mute),
      });

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 8.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('pfl', x + 24, 420);
      ctx.fillText('mute', x + colW - 24, 420);

      // Peak LED driven by real C++ meter
      const isPeaking = dispMeters.ch[i].rawDb >= -3.5 && !ch.mute;
      ctx.beginPath();
      ctx.arc(cx, 405, 4, 0, Math.PI * 2);
      ctx.fillStyle = isPeaking ? '#ef4444' : '#450a0a';
      if (isPeaking) {
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 9;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('peak', cx, 420);

      // Fader Section (White/Dark for 1-6, Emerald Green for 7-8 & 9-10)
      const faderBoxY = 444;
      const faderBoxH = 296;
      roundRect(x, faderBoxY, colW, faderBoxH, 8);
      ctx.fillStyle = isGreen ? '#0f3d28' : '#1b2027';
      ctx.fill();
      ctx.strokeStyle = isGreen ? '#10b981' : '#2d3540';
      ctx.lineWidth = isGreen ? 1.5 : 1;
      ctx.stroke();

      ctx.fillStyle = isGreen ? '#a7f3d0' : '#e2e8f0';
      ctx.font = '700 10px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(truncateText(ch.name, 14), cx, faderBoxY + 15);

      const chMeterLevel = Math.max(dispMeters.ch[i].l, dispMeters.ch[i].r);
      drawFader({
        cx: cx + 4,
        topY: faderBoxY + 26,
        height: 228,
        value: dbToFaderNorm(ch.faderDb ?? 0),
        capColor: isGreen ? 'green' : 'white',
        controlId: `fader_${i}`,
        label: `${ch.name} Fader`,
        meterNorm: chMeterLevel,
        showMeter: true,
        onChange: (val) => sendChParam(i, 'faderDb', faderNormToDb(val)),
        formatText: (val) => {
          const db = faderNormToDb(val);
          return `${ch.name} FADER: ${db <= -89 ? '-∞' : db > 0 ? `+${db}` : db} dB`;
        },
      });

      // Bottom strip badge
      if (isGreen) {
        roundRect(x + 8, faderBoxY + faderBoxH - 25, colW - 16, 18, 4);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.fillStyle = '#022c22';
        ctx.font = '800 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
        ctx.fillText(i === 6 ? '7-8 BGM' : '9-10 PADS', cx, faderBoxY + faderBoxH - 13);
      } else {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
        ctx.fillText(`${i + 1}`, cx, faderBoxY + faderBoxH - 11);
      }
    }

    // 3. Right Master Section (x: 1022 .. 1338, width 316)
    const rx = 1022;
    const rw = 316;

    // Top Audio I/O Patch Card (Condensed replacement for dummy XLR/TRS/RCA bays)
    roundRect(rx, 16, rw, 70, 8);
    ctx.fillStyle = '#1b2027';
    ctx.fill();
    ctx.strokeStyle = hoveredControl === 'patch_card' ? '#38bdf8' : '#333c48';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    interactiveControls.push({
      type: 'button',
      id: 'patch_card',
      x: rx,
      y: 16,
      w: rw,
      h: 70,
      label: 'Buka Pengaturan Audio I/O & OBS',
      onClick: () => audioDialog.showModal(),
    });

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('AUDIO I/O PATCH', rx + 10, 31);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#38bdf8';
    const srKhz = ((audioStatus?.sampleRate || 48000) / 1000).toFixed(1).replace('.0', '');
    ctx.fillText(`${srKhz}kHz · SETUP ⚙`, rx + rw - 10, 31);

    const cfg = appState.audioConfig || {};
    const micName = shortDeviceName(cfg.inputDevId, 'Default Mic');
    const musName = shortDeviceName(cfg.musicInputDevId, 'BGM Internal');
    const monName = shortDeviceName(cfg.monitorOutDevId, 'Default HP');
    const obsName = shortDeviceName(cfg.streamOutDevId, 'OBS Virtual');

    ctx.textAlign = 'left';
    ctx.font = '600 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`MIC: ${truncateText(micName, 17)}`, rx + 10, 49);
    ctx.fillText(`MON: ${truncateText(monName, 17)}`, rx + 10, 66);
    ctx.fillText(`MUS: ${truncateText(musName, 17)}`, rx + 162, 49);
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText(`OBS: ${truncateText(obsName, 17)}`, rx + 162, 66);

    // Brand Logo + Auto-Duck Card (Phantom +48V aesthetic)
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '800 20px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillText('DM Audio', rx + 8, 118);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillText('DIGITAL MIXER', rx + 8, 134);

    const duckBoxX = rx + 126;
    const duckBoxW = rw - 126;
    roundRect(duckBoxX, 92, duckBoxW, 56, 7);
    ctx.fillStyle = '#1b2027';
    ctx.fill();
    ctx.strokeStyle = '#333c48';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('auto-duck voice', duckBoxX + duckBoxW / 2, 106);

    drawToggleButton({
      x: duckBoxX + duckBoxW / 2 - 16,
      y: 116,
      w: 32,
      h: 20,
      active: Boolean(g.autoDuckEnabled),
      activeColor: '#ef4444',
      offColor: '#7f1d1d',
      controlId: 'auto_duck_sw',
      label: 'Toggle Auto-Duck',
      onClick: () => sendGlobalParam('autoDuckEnabled', !g.autoDuckEnabled),
    });

    ctx.textAlign = 'left';
    ctx.font = '700 9px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillStyle = g.autoDuckEnabled ? '#fca5a5' : '#94a3b8';
    ctx.fillText(g.autoDuckEnabled ? 'ON' : 'OFF', duckBoxX + 16, 130);
    ctx.textAlign = 'right';
    ctx.fillStyle = Math.abs(dispMeters.duckDb) > 0.3 ? '#facc15' : '#64748b';
    ctx.fillText(`${dispMeters.duckDb.toFixed(1)}dB`, duckBoxX + duckBoxW - 12, 130);

    // FX Return & Ducking Depth Knob Box (y: 154..250)
    roundRect(rx, 154, rw, 94, 7);
    ctx.fillStyle = '#1b2027';
    ctx.fill();
    ctx.strokeStyle = '#333c48';
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('fx return · reverb · ducking', rx + rw / 2, 169);

    drawKnob({
      cx: rx + 54,
      cy: 208,
      radius: 16,
      value: clamp(((g.fxReturnDb ?? 0) + 60) / 66, 0, 1),
      resetVal: 60 / 66,
      color: '#22c55e',
      label: 'fx ret',
      leftLbl: '-60',
      rightLbl: '+6',
      controlId: 'fx_ret_db',
      onChange: (val) => sendGlobalParam('fxReturnDb', Number((-60 + val * 66).toFixed(1))),
      formatText: (val) => `FX RETURN: ${(-60 + val * 66).toFixed(1)} dB`,
    });

    drawKnob({
      cx: rx + 158,
      cy: 208,
      radius: 16,
      value: clamp(((g.reverbDecay ?? 0.55) - 0.15) / 0.8, 0, 1),
      resetVal: 0.5,
      color: '#38bdf8',
      label: 'reverb',
      leftLbl: 'room',
      rightLbl: 'hall',
      controlId: 'rev_decay',
      onChange: (val) => sendGlobalParam('reverbDecay', Number((0.15 + val * 0.8).toFixed(2))),
      formatText: (val) => `REVERB DECAY: ${Math.round(val * 100)}%`,
    });

    drawKnob({
      cx: rx + 262,
      cy: 208,
      radius: 16,
      value: clamp(Math.abs(g.autoDuckDepthDb ?? -9) / 24, 0, 1),
      resetVal: 9 / 24,
      color: '#f43f5e',
      label: 'duck dB',
      leftLbl: '0',
      rightLbl: '-24',
      controlId: 'duck_depth',
      onChange: (val) => sendGlobalParam('autoDuckDepthDb', Number((-val * 24).toFixed(1))),
      formatText: (val) => `AUTO-DUCK DEPTH: ${(-val * 24).toFixed(1)} dB`,
    });

    // Aux Masters / 2-Track BGM + 10-Row LED Master Meters (y: 254..436)
    const auxW = 144;
    roundRect(rx, 254, auxW, 182, 7);
    ctx.fillStyle = '#1b2027';
    ctx.fill();
    ctx.strokeStyle = '#333c48';
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('aux & 2-track', rx + auxW / 2, 270);

    drawPillButton({
      x: rx + 14,
      y: 282,
      w: auxW - 28,
      h: 24,
      text: g.fxReturnMute ? 'FX MUTE: ON' : 'FX RETURN: ON',
      active: !g.fxReturnMute,
      activeBg: '#047857',
      activeBorder: '#34d399',
      offBg: '#7f1d1d',
      offBorder: '#ef4444',
      offText: '#fecaca',
      fontSize: 8.5,
      controlId: 'fx_ret_mute',
      label: 'FX Return Mute',
      onClick: () => sendGlobalParam('fxReturnMute', !g.fxReturnMute),
    });

    drawPillButton({
      x: rx + 14,
      y: 314,
      w: auxW - 28,
      h: 24,
      text: g.bgmPlaying ? '2TRK PLAY: ON' : '2TRK PAUSED',
      active: Boolean(g.bgmPlaying),
      activeBg: '#0369a1',
      activeBorder: '#38bdf8',
      fontSize: 8.5,
      controlId: 'bgm_play_canv',
      label: 'Play / Pause BGM',
      onClick: () => {
        if (!appState.bgm?.trackName) bgmUploadInput.click();
        else sendGlobalParam('bgmPlaying', !g.bgmPlaying);
      },
    });

    drawPillButton({
      x: rx + 14,
      y: 346,
      w: auxW - 28,
      h: 24,
      text: g.bgmLoop ? '2TRK LOOP: ON' : '2TRK LOOP: OFF',
      active: Boolean(g.bgmLoop),
      activeBg: '#0369a1',
      activeBorder: '#38bdf8',
      fontSize: 8.5,
      controlId: 'bgm_loop_canv',
      label: 'BGM Loop Toggle',
      onClick: () => sendGlobalParam('bgmLoop', !g.bgmLoop),
    });

    const ch0Tone = Boolean(appState.channels[0]?.testTone);
    drawPillButton({
      x: rx + 14,
      y: 378,
      w: auxW - 28,
      h: 24,
      text: ch0Tone ? 'TEST TONE: ON' : 'TEST TONE: OFF',
      active: ch0Tone,
      activeBg: '#b45309',
      activeBorder: '#f59e0b',
      activeText: '#fde68a',
      fontSize: 8.5,
      controlId: 'test_tone_canv',
      label: '1kHz Test Tone',
      onClick: () => sendChParam(0, 'testTone', !ch0Tone),
    });

    drawPillButton({
      x: rx + 14,
      y: 408,
      w: auxW - 28,
      h: 20,
      text: meterBusMode === 'stream' ? 'METER: OBS MIX' : 'METER: PHONES',
      active: meterBusMode === 'stream',
      activeBg: '#1d4ed8',
      activeBorder: '#60a5fa',
      offBg: '#065f46',
      offBorder: '#34d399',
      offText: '#a7f3d0',
      fontSize: 8,
      controlId: 'meter_bus_sw',
      label: 'Pilih Sumber Master Meter',
      onClick: () => {
        meterBusMode = meterBusMode === 'stream' ? 'monitor' : 'stream';
      },
    });

    // Master Meters Box (10-Row Circular LED Stereo Meter)
    const meterX = rx + auxW + 6;
    const meterW = rw - auxW - 6;
    roundRect(meterX, 254, meterW, 182, 7);
    ctx.fillStyle = '#1b2027';
    ctx.fill();
    ctx.strokeStyle = '#333c48';
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 9.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('master meters', meterX + meterW / 2, 269);

    // pow & pfl LEDs
    ctx.beginPath();
    ctx.arc(meterX + 26, 286, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = audioStatus.running ? '#22c55e' : '#ef4444';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 7;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(meterX + meterW - 26, 286, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = anySolo ? '#facc15' : '#422006';
    if (anySolo) {
      ctx.shadowColor = '#facc15';
      ctx.shadowBlur = 7;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = '600 7.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('pow', meterX + 42, 288);
    ctx.fillText('pfl', meterX + meterW - 42, 288);

    const busMeter = meterBusMode === 'stream' ? dispMeters.stream : dispMeters.monitor;
    const ledLevels = [
      { db: '+16', thresh: 0.94, color: '#ef4444' },
      { db: '+10', thresh: 0.85, color: '#ef4444' },
      { db: '6', thresh: 0.76, color: '#facc15' },
      { db: '3', thresh: 0.67, color: '#facc15' },
      { db: '0', thresh: 0.58, color: '#facc15' },
      { db: '-3', thresh: 0.48, color: '#22c55e' },
      { db: '-6', thresh: 0.38, color: '#22c55e' },
      { db: '-12', thresh: 0.28, color: '#22c55e' },
      { db: '-16', thresh: 0.16, color: '#22c55e' },
      { db: '-22', thresh: 0.05, color: '#22c55e' },
    ];

    ledLevels.forEach((led, idx) => {
      const ly = 302 + idx * 12.2;
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '700 7.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(led.db, meterX + meterW / 2, ly + 2.5);

      const litL = busMeter.l >= led.thresh;
      ctx.beginPath();
      ctx.arc(meterX + 36, ly, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = litL ? led.color : '#0f172a';
      if (litL) {
        ctx.shadowColor = led.color;
        ctx.shadowBlur = 7;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      const litR = busMeter.r >= led.thresh;
      ctx.beginPath();
      ctx.arc(meterX + meterW - 36, ly, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = litR ? led.color : '#0f172a';
      if (litR) {
        ctx.shadowColor = led.color;
        ctx.shadowBlur = 7;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 8px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillText('L', meterX + 36, 427);
    ctx.fillText('R', meterX + meterW - 36, 427);

    // 4. Master Mix Dual Red Faders (STREAM OBS + PHONES MON)
    const mixBoxY = 444;
    const mixBoxH = 296;
    roundRect(rx, mixBoxY, rw, mixBoxH, 8);
    ctx.fillStyle = '#451217';
    ctx.fill();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Top mute switches for Stream & Monitor masters
    drawPillButton({
      x: rx + 26,
      y: mixBoxY + 6,
      w: 112,
      h: 17,
      text: g.streamMasterMute ? 'OBS MUTED' : 'STREAM (OBS)',
      active: !g.streamMasterMute,
      activeBg: '#991b1b',
      activeBorder: '#f87171',
      activeText: '#fecaca',
      offBg: '#ef4444',
      offBorder: '#ffffff',
      offText: '#ffffff',
      fontSize: 8,
      controlId: 'stream_mute_btn',
      label: 'Stream Master Mute',
      onClick: () => sendGlobalParam('streamMasterMute', !g.streamMasterMute),
    });

    drawPillButton({
      x: rx + 178,
      y: mixBoxY + 6,
      w: 112,
      h: 17,
      text: g.monitorMasterMute ? 'HP MUTED' : 'PHONES (MON)',
      active: !g.monitorMasterMute,
      activeBg: '#991b1b',
      activeBorder: '#f87171',
      activeText: '#fecaca',
      offBg: '#ef4444',
      offBorder: '#ffffff',
      offText: '#ffffff',
      fontSize: 8,
      controlId: 'mon_mute_btn',
      label: 'Monitor Master Mute',
      onClick: () => sendGlobalParam('monitorMasterMute', !g.monitorMasterMute),
    });

    drawFader({
      cx: rx + 76,
      topY: mixBoxY + 28,
      height: 226,
      value: dbToFaderNorm(g.streamMasterDb ?? 0),
      capColor: 'red',
      controlId: 'master_stream_fader',
      label: 'Stream (OBS) Master Fader',
      meterNorm: Math.max(dispMeters.stream.l, dispMeters.stream.r),
      showMeter: true,
      onChange: (val) => sendGlobalParam('streamMasterDb', faderNormToDb(val)),
      formatText: (val) => {
        const db = faderNormToDb(val);
        return `STREAM (OBS) MASTER: ${db <= -89 ? '-∞' : db > 0 ? `+${db}` : db} dB`;
      },
    });

    drawFader({
      cx: rx + 228,
      topY: mixBoxY + 28,
      height: 226,
      value: dbToFaderNorm(g.monitorMasterDb ?? 0),
      capColor: 'red',
      controlId: 'master_mon_fader',
      label: 'Phones (Monitor) Master Fader',
      meterNorm: Math.max(dispMeters.monitor.l, dispMeters.monitor.r),
      showMeter: true,
      onChange: (val) => sendGlobalParam('monitorMasterDb', faderNormToDb(val)),
      formatText: (val) => {
        const db = faderNormToDb(val);
        return `PHONES (MON) MASTER: ${db <= -89 ? '-∞' : db > 0 ? `+${db}` : db} dB`;
      },
    });

    roundRect(rx + 12, mixBoxY + mixBoxH - 25, rw - 24, 18, 4);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 10px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('MASTER MIX · OBS STREAM & MONITOR', rx + rw / 2, mixBoxY + mixBoxH - 13);
  }

  // Animation Loop (smooth meter ballistics + canvas repaint)
  function tickAnimation() {
    for (let i = 0; i < 8; i++) {
      const tL = dbToMeterNorm(targetMeters.ch[i].l);
      const tR = dbToMeterNorm(targetMeters.ch[i].r);
      dispMeters.ch[i].l += (tL - dispMeters.ch[i].l) * (tL > dispMeters.ch[i].l ? 0.55 : 0.16);
      dispMeters.ch[i].r += (tR - dispMeters.ch[i].r) * (tR > dispMeters.ch[i].r ? 0.55 : 0.16);
      dispMeters.ch[i].rawDb = Math.max(targetMeters.ch[i].l, targetMeters.ch[i].r);
    }

    const sL = dbToMeterNorm(targetMeters.stream[0]);
    const sR = dbToMeterNorm(targetMeters.stream[1]);
    dispMeters.stream.l += (sL - dispMeters.stream.l) * (sL > dispMeters.stream.l ? 0.55 : 0.16);
    dispMeters.stream.r += (sR - dispMeters.stream.r) * (sR > dispMeters.stream.r ? 0.55 : 0.16);

    const mL = dbToMeterNorm(targetMeters.monitor[0]);
    const mR = dbToMeterNorm(targetMeters.monitor[1]);
    dispMeters.monitor.l += (mL - dispMeters.monitor.l) * (mL > dispMeters.monitor.l ? 0.55 : 0.16);
    dispMeters.monitor.r += (mR - dispMeters.monitor.r) * (mR > dispMeters.monitor.r ? 0.55 : 0.16);

    dispMeters.duckDb += (targetMeters.duckDb - dispMeters.duckDb) * 0.35;
    if (appState?.globals?.autoDuckEnabled && Math.abs(dispMeters.duckDb) > 0.3) {
      duckDbBadge.textContent = `${dispMeters.duckDb.toFixed(1)} dB`;
    }

    renderMixer();
    requestAnimationFrame(tickAnimation);
  }

  // Canvas Pointer & Wheel Interaction
  function getLogicalPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  }

  function hitTest(lx, ly) {
    for (let i = interactiveControls.length - 1; i >= 0; i--) {
      const c = interactiveControls[i];
      if (lx >= c.x && lx <= c.x + c.w && ly >= c.y && ly <= c.y + c.h) {
        return c;
      }
    }
    return null;
  }

  function handlePointerDown(clientX, clientY) {
    const pos = getLogicalPos(clientX, clientY);
    const hit = hitTest(pos.x, pos.y);
    if (!hit) return;

    if (hit.type === 'button') {
      hit.onClick();
      setReadout(`Tombol: ${hit.label}`);
      return;
    }

    activeDrag = {
      controlId: hit.id,
      type: hit.type,
      startY: pos.y,
      startVal: hit.value,
      topY: hit.topY,
      travel: hit.travel,
      onChange: hit.onChange,
      formatText: hit.formatText,
    };

    if (hit.type === 'fader') {
      const nextVal = clamp(1 - (pos.y - hit.topY) / hit.travel, 0, 1);
      activeDrag.startVal = nextVal;
      hit.onChange(nextVal);
      if (hit.formatText) setReadout(hit.formatText(nextVal));
    } else if (hit.formatText) {
      setReadout(hit.formatText(hit.value));
    }
  }

  function handlePointerMove(clientX, clientY) {
    const pos = getLogicalPos(clientX, clientY);

    if (activeDrag) {
      let nextVal = activeDrag.startVal;
      if (activeDrag.type === 'knob') {
        const deltaY = activeDrag.startY - pos.y;
        nextVal = clamp(activeDrag.startVal + deltaY / 160, 0, 1);
      } else if (activeDrag.type === 'fader') {
        nextVal = clamp(1 - (pos.y - activeDrag.topY) / activeDrag.travel, 0, 1);
      }
      activeDrag.onChange(nextVal);
      if (activeDrag.formatText) setReadout(activeDrag.formatText(nextVal));
      return;
    }

    const hit = hitTest(pos.x, pos.y);
    hoveredControl = hit ? hit.id : null;
    canvas.style.cursor = hit ? (hit.type === 'button' ? 'pointer' : 'ns-resize') : 'default';
  }

  function handlePointerUp() {
    activeDrag = null;
  }

  function handleDoubleClick(clientX, clientY) {
    const pos = getLogicalPos(clientX, clientY);
    const hit = hitTest(pos.x, pos.y);
    if (!hit || hit.type === 'button') return;

    hit.onChange(hit.resetVal);
    if (hit.formatText) setReadout(`Reset · ${hit.formatText(hit.resetVal)}`);
  }

  canvas.addEventListener('mousedown', (e) => handlePointerDown(e.clientX, e.clientY));
  window.addEventListener('mousemove', (e) => handlePointerMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', handlePointerUp);
  canvas.addEventListener('dblclick', (e) => handleDoubleClick(e.clientX, e.clientY));

  canvas.addEventListener(
    'wheel',
    (e) => {
      const pos = getLogicalPos(e.clientX, e.clientY);
      const hit = hitTest(pos.x, pos.y);
      if (!hit || hit.type === 'button') return;
      e.preventDefault();
      const step = (e.deltaY < 0 ? 1 : -1) * (hit.type === 'knob' ? 0.03 : 0.025);
      const nextVal = clamp(hit.value + step, 0, 1);
      hit.onChange(nextVal);
      if (hit.formatText) setReadout(hit.formatText(nextVal));
    },
    { passive: false }
  );

  canvas.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length > 0) {
        const t = e.touches[0];
        const pos = getLogicalPos(t.clientX, t.clientY);
        const hit = hitTest(pos.x, pos.y);
        if (hit) {
          e.preventDefault();
          handlePointerDown(t.clientX, t.clientY);
        }
      }
    },
    { passive: false }
  );

  window.addEventListener(
    'touchmove',
    (e) => {
      if (activeDrag && e.touches.length > 0) {
        e.preventDefault();
        handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    },
    { passive: false }
  );

  window.addEventListener('touchend', handlePointerUp);

  // Header & Modal Listeners
  sceneBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.scene-btn');
    if (!btn) return;
    sendWs({ type: 'recall_scene', sceneId: btn.dataset.scene });
    setReadout(`Scene dipanggil: ${btn.textContent}`);
  });

  bgmLoadBtn.addEventListener('click', () => {
    bgmUploadInput.value = '';
    bgmUploadInput.click();
  });

  bgmUploadInput.addEventListener('change', async () => {
    const file = bgmUploadInput.files?.[0];
    if (!file) return;
    try {
      setReadout(`Memproses BGM: ${file.name}...`);
      const wavBuf = await decodeAudioFileToWavBuffer(file);
      const res = await fetch(`/api/upload-bgm?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: wavBuf,
      });
      if (!res.ok) throw new Error(await res.text());
      setReadout(`BGM siap diputar: ${file.name}`);
    } catch (err) {
      setReadout(`Gagal memuat BGM: ${err.message}`);
    }
  });

  bgmPlayBtn.addEventListener('click', () => {
    if (!appState) return;
    if (!appState.bgm?.trackName) {
      bgmUploadInput.click();
      return;
    }
    sendGlobalParam('bgmPlaying', !appState.globals.bgmPlaying);
  });

  bgmRestartBtn?.addEventListener('click', () => {
    sendWs({ type: 'bgm_restart' });
    setReadout('BGM diulang dari awal');
  });

  bgmLoopBtn.addEventListener('click', () => {
    if (!appState) return;
    sendGlobalParam('bgmLoop', !appState.globals.bgmLoop);
  });

  autoDuckBtn.addEventListener('click', () => {
    if (!appState) return;
    sendGlobalParam('autoDuckEnabled', !appState.globals.autoDuckEnabled);
  });

  togglePadsBtn.addEventListener('click', () => {
    soundboardDock.classList.toggle('is-collapsed');
    togglePadsBtn.classList.toggle('is-active', !soundboardDock.classList.contains('is-collapsed'));
    resizeCanvas();
  });

  toggleFatBtn.addEventListener('click', () => {
    fatPanel.classList.toggle('is-collapsed');
    const open = !fatPanel.classList.contains('is-collapsed');
    toggleFatBtn.classList.toggle('is-active', open);
    if (open) renderFatInspector();
    resizeCanvas();
  });

  fatCloseBtn.addEventListener('click', () => {
    fatPanel.classList.add('is-collapsed');
    toggleFatBtn.classList.remove('is-active');
    resizeCanvas();
  });

  stopPadsBtn.addEventListener('click', () => {
    sendWs({ type: 'pad_stop_all' });
    setReadout('Semua Soundboard Pad dihentikan');
  });

  wavUploadInput.addEventListener('change', async () => {
    const file = wavUploadInput.files?.[0];
    if (!file) return;
    try {
      setReadout(`Upload Pad ${pendingPadUpload + 1}: ${file.name}...`);
      const wavBuf = await decodeAudioFileToWavBuffer(file);
      const res = await fetch(
        `/api/upload-wav?pad=${pendingPadUpload}&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: wavBuf,
        }
      );
      if (!res.ok) throw new Error(await res.text());
      setReadout(`Pad ${pendingPadUpload + 1} diperbarui: ${file.name}`);
    } catch (err) {
      setReadout(`Gagal upload Pad: ${err.message}`);
    }
  });

  audioSetupBtn.addEventListener('click', () => {
    sendWs({ type: 'refresh_devices' });
    updateAudioHardwareMeta();
    audioDialog.showModal();
  });

  selInputDev.addEventListener('change', updateAudioHardwareMeta);
  selMonDev.addEventListener('change', updateAudioHardwareMeta);

  presetSelect?.addEventListener('change', () => {
    const id = presetSelect.value;
    if (!id) return;
    sendWs({ type: 'recall_preset', presetId: id });
    const p = (appState?.userPresets || []).find((x) => x.id === id);
    setReadout(`Preset dimuat: ${p?.name || id}`);
  });

  savePresetBtn?.addEventListener('click', () => {
    renderUserPresets();
    if (presetNameInput) presetNameInput.value = '';
    presetDialog?.showModal();
    presetNameInput?.focus();
  });

  confirmSavePresetBtn?.addEventListener('click', () => {
    const name = (presetNameInput?.value || '').trim();
    if (!name) return;
    sendWs({ type: 'save_preset', name });
    if (presetNameInput) presetNameInput.value = '';
    presetDialog?.close();
    setReadout(`Preset disimpan: ${name}`);
  });

  remoteInfoBtn.addEventListener('click', () => {
    renderLanList();
    remoteDialog.showModal();
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeDialog)?.close();
    });
  });

  refreshDevBtn.addEventListener('click', () => {
    sendWs({ type: 'refresh_devices' });
    setReadout('Daftar audio device diperbarui');
  });

  applyAudioBtn.addEventListener('click', () => {
    const config = {
      inputDevId: selInputDev.value,
      musicInputDevId: selMusicInputDev.value,
      monitorOutDevId: selMonDev.value,
      streamOutDevId: selStreamDev.value,
      bufferSize: Number(selBufSize.value || 256),
      sampleRate: Number(selSampleRate?.value || 0),
    };
    sendWs({ type: 'audio_config', config });
    audioDialog.close();
    setReadout('Konfigurasi Audio Interface diterapkan');
  });

  resetAllBtn.addEventListener('click', async () => {
    await fetch('/api/reset', { method: 'POST' });
    remoteDialog.close();
    setReadout('Mixer di-reset ke pengaturan default');
  });

  connectWs();
  requestAnimationFrame(tickAnimation);
})();
