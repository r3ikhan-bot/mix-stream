const app = {
  state: null,
  devices: [],
  audioStatus: { running: false, sampleRate: 48000, text: 'Connecting...' },
  lanUrls: [],
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 800,
  uploadPadIdx: 0,
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
  audioDialog: document.getElementById('audio-dialog'),
  adStatusSub: document.getElementById('ad-status-sub'),
  selInputDev: document.getElementById('sel-input-dev'),
  selMonDev: document.getElementById('sel-mon-dev'),
  selStreamDev: document.getElementById('sel-stream-dev'),
  selBufSize: document.getElementById('sel-buf-size'),
  refreshDevBtn: document.getElementById('refresh-dev-btn'),
  applyAudioBtn: document.getElementById('apply-audio-btn'),
  remoteDialog: document.getElementById('remote-dialog'),
  lanList: document.getElementById('lan-list'),
  resetAllBtn: document.getElementById('reset-all-btn'),
};

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
  return `${db > 0 ? '+' : ''}${Number(db).toFixed(1)} dB`;
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
        if (window.innerWidth <= 900) dom.fatPanel.hidden = true;
        renderAll();
        break;
      case 'full_state':
        app.state = msg.state;
        renderAll();
        break;
      case 'devices':
        app.devices = msg.devices || [];
        populateDeviceSelects();
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
          if (app.state.selectedChannel === msg.index) renderFatChannel();
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
          renderFatChannel();
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

function updateLiveMeters(m) {
  if (!m) return;
  if (Array.isArray(m.ch)) {
    m.ch.forEach((pair, idx) => {
      const lEl = document.querySelector(`[data-meter="ch-${idx}-l"]`);
      const rEl = document.querySelector(`[data-meter="ch-${idx}-r"]`);
      if (lEl) lEl.style.setProperty('--meter-pct', `${dbToMeterPct(pair[0])}%`);
      if (rEl) rEl.style.setProperty('--meter-pct', `${dbToMeterPct(pair[1])}%`);
      if (app.state?.selectedChannel === idx) {
        const grEl = document.getElementById('fat-comp-gr');
        if (grEl) grEl.textContent = `GR: -${Number(pair[2] || 0).toFixed(1)} dB`;
      }
    });
  }
  if (Array.isArray(m.stream)) {
    const sl = document.querySelector('[data-meter="stream-l"]');
    const sr = document.querySelector('[data-meter="stream-r"]');
    if (sl) sl.style.setProperty('--meter-pct', `${dbToMeterPct(m.stream[0])}%`);
    if (sr) sr.style.setProperty('--meter-pct', `${dbToMeterPct(m.stream[1])}%`);
  }
  if (Array.isArray(m.monitor)) {
    const ml = document.querySelector('[data-meter="mon-l"]');
    const mr = document.querySelector('[data-meter="mon-r"]');
    if (ml) ml.style.setProperty('--meter-pct', `${dbToMeterPct(m.monitor[0])}%`);
    if (mr) mr.style.setProperty('--meter-pct', `${dbToMeterPct(m.monitor[1])}%`);
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

function createLedMeterPair(idPrefix) {
  const pair = document.createElement('div');
  pair.className = 'meter-pair';
  for (const side of ['l', 'r']) {
    const col = document.createElement('div');
    col.className = 'meter-col';
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.dataset.meter = `${idPrefix}-${side}`;
    col.append(fill);
    pair.append(col);
  }
  return pair;
}

function createDbScale() {
  const scale = document.createElement('div');
  scale.className = 'db-scale';
  scale.setAttribute('aria-hidden', 'true');
  for (const mark of ['+10', '+5', '0', '-5', '-15', '-30', '-∞']) {
    const s = document.createElement('span');
    s.textContent = mark;
    scale.append(s);
  }
  return scale;
}

function renderConsole() {
  if (!app.state) return;
  dom.consoleRack.replaceChildren();

  for (const ch of app.state.channels) {
    const strip = document.createElement('article');
    strip.className = `s1-strip${app.state.selectedChannel === ch.index ? ' is-selected' : ''}`;
    strip.style.setProperty('--ch-color', ch.color);

    // Top Role Bar
    const roleBar = document.createElement('div');
    roleBar.className = 'strip-top-role';
    const roleTxt = document.createElement('span');
    roleTxt.textContent = ch.role;
    const toneBtn = document.createElement('button');
    toneBtn.type = 'button';
    toneBtn.className = 'micro-btn';
    toneBtn.setAttribute('aria-pressed', String(Boolean(ch.testTone)));
    toneBtn.textContent = 'Tone';
    toneBtn.title = 'Aktifkan nada uji untuk tes routing ke OBS / TTLS';
    toneBtn.addEventListener('click', () => {
      setChParam(ch.index, 'testTone', !ch.testTone);
      toneBtn.setAttribute('aria-pressed', String(ch.testTone));
    });
    roleBar.append(roleTxt, toneBtn);

    // Input Controls (Trim, Phase, HPF)
    const inputBlock = document.createElement('div');
    inputBlock.className = 'strip-block';
    const inHead = document.createElement('div');
    inHead.className = 'block-head';
    const inTitle = document.createElement('span');
    inTitle.textContent = 'Input';
    const inPills = document.createElement('div');
    inPills.className = 'io-pills';

    const phaseBtn = document.createElement('button');
    phaseBtn.type = 'button';
    phaseBtn.className = 'micro-btn';
    phaseBtn.setAttribute('aria-pressed', String(Boolean(ch.phaseInvert)));
    phaseBtn.textContent = 'Ø';
    phaseBtn.addEventListener('click', () => {
      setChParam(ch.index, 'phaseInvert', !ch.phaseInvert);
      phaseBtn.setAttribute('aria-pressed', String(ch.phaseInvert));
    });

    const hpfBtn = document.createElement('button');
    hpfBtn.type = 'button';
    hpfBtn.className = 'micro-btn';
    hpfBtn.setAttribute('aria-pressed', String(Boolean(ch.hpfOn)));
    hpfBtn.textContent = 'HPF';
    hpfBtn.addEventListener('click', () => {
      setChParam(ch.index, 'hpfOn', !ch.hpfOn);
      hpfBtn.setAttribute('aria-pressed', String(ch.hpfOn));
    });

    inPills.append(phaseBtn, hpfBtn);
    inHead.append(inTitle, inPills);

    const trimSlider = document.createElement('input');
    trimSlider.type = 'range';
    trimSlider.className = 'h-mini';
    trimSlider.min = '-24';
    trimSlider.max = '24';
    trimSlider.step = '0.5';
    trimSlider.value = String(ch.trimDb);
    trimSlider.ariaLabel = `Input Trim ${ch.name}`;
    syncSlider(trimSlider);
    trimSlider.addEventListener('input', () => {
      syncSlider(trimSlider);
      setChParam(ch.index, 'trimDb', Number(trimSlider.value));
    });
    addDoubleTapReset(trimSlider, () => {
      trimSlider.value = '0';
      trimSlider.dispatchEvent(new Event('input'));
    });

    inputBlock.append(inHead, trimSlider);

    // Studio One Inserts (Gate, EQ, Comp)
    const insBlock = document.createElement('div');
    insBlock.className = 'strip-block';
    const insHead = document.createElement('div');
    insHead.className = 'block-head';
    insHead.textContent = 'Inserts';
    insBlock.append(insHead);

    const inserts = [
      { key: 'gateOn', label: 'Gate' },
      { key: 'eqOn', label: 'Pro EQ' },
      { key: 'compOn', label: 'Comp' },
    ];
    for (const ins of inserts) {
      const pill = document.createElement('div');
      pill.className = 'insert-pill';
      const led = document.createElement('button');
      led.type = 'button';
      led.className = `led-dot${ch[ins.key] ? ' is-on' : ''}`;
      led.ariaLabel = `Toggle ${ins.label} ${ch.name}`;
      led.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !ch[ins.key];
        setChParam(ch.index, ins.key, next);
        led.classList.toggle('is-on', next);
      });
      const lbl = document.createElement('span');
      lbl.className = 'insert-name';
      lbl.textContent = ins.label;
      pill.append(led, lbl);
      pill.addEventListener('click', () => {
        app.state.selectedChannel = ch.index;
        dom.fatPanel.hidden = false;
        syncTopStatus();
        renderConsole();
        renderFatChannel();
      });
      insBlock.append(pill);
    }

    // Sends & OBS / MON Routing
    const sendBlock = document.createElement('div');
    sendBlock.className = 'strip-block';
    const sendHead = document.createElement('div');
    sendHead.className = 'block-head';
    sendHead.textContent = 'Sends & Out';

    const revSlider = document.createElement('input');
    revSlider.type = 'range';
    revSlider.className = 'h-mini';
    revSlider.min = '0';
    revSlider.max = '1';
    revSlider.step = '0.01';
    revSlider.value = String(ch.reverbSend);
    revSlider.ariaLabel = `Reverb Send ${ch.name}`;
    syncSlider(revSlider);
    revSlider.addEventListener('input', () => {
      syncSlider(revSlider);
      setChParam(ch.index, 'reverbSend', Number(revSlider.value));
    });

    const routeRow = document.createElement('div');
    routeRow.className = 'route-row';

    const obsBtn = document.createElement('button');
    obsBtn.type = 'button';
    obsBtn.className = 'route-btn obs';
    obsBtn.setAttribute('aria-pressed', String(Boolean(ch.routeStream)));
    obsBtn.textContent = 'OBS';
    obsBtn.addEventListener('click', () => {
      setChParam(ch.index, 'routeStream', !ch.routeStream);
      obsBtn.setAttribute('aria-pressed', String(ch.routeStream));
    });

    const monBtn = document.createElement('button');
    monBtn.type = 'button';
    monBtn.className = 'route-btn mon';
    monBtn.setAttribute('aria-pressed', String(Boolean(ch.routeMonitor)));
    monBtn.textContent = 'MON';
    monBtn.addEventListener('click', () => {
      setChParam(ch.index, 'routeMonitor', !ch.routeMonitor);
      monBtn.setAttribute('aria-pressed', String(ch.routeMonitor));
    });

    routeRow.append(obsBtn, monBtn);
    sendBlock.append(sendHead, revSlider, routeRow);

    // Pan
    const panBlock = document.createElement('div');
    panBlock.className = 'strip-block';
    const panSlider = document.createElement('input');
    panSlider.type = 'range';
    panSlider.className = 'h-mini';
    panSlider.min = '-1';
    panSlider.max = '1';
    panSlider.step = '0.02';
    panSlider.value = String(ch.pan);
    panSlider.ariaLabel = `Pan ${ch.name}`;
    syncSlider(panSlider);
    panSlider.addEventListener('input', () => {
      syncSlider(panSlider);
      setChParam(ch.index, 'pan', Number(panSlider.value));
    });
    addDoubleTapReset(panSlider, () => {
      panSlider.value = '0';
      panSlider.dispatchEvent(new Event('input'));
    });
    panBlock.append(panSlider);

    // Fader + Live Stereo Meter Well
    const well = document.createElement('div');
    well.className = 'fader-meter-well';

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'v-fader';
    fader.min = '0';
    fader.max = '100';
    fader.value = String(faderToLinearSlider(ch.faderDb));
    fader.ariaLabel = `Fader ${ch.name}`;
    syncSlider(fader);

    const dbReadout = document.createElement('div');
    dbReadout.className = 'db-readout';
    dbReadout.textContent = formatDb(ch.faderDb);

    fader.addEventListener('input', () => {
      syncSlider(fader);
      const db = linearSliderToDb(fader.value);
      dbReadout.textContent = formatDb(db);
      setChParam(ch.index, 'faderDb', db);
    });
    addDoubleTapReset(fader, () => {
      fader.value = String(faderToLinearSlider(0));
      fader.dispatchEvent(new Event('input'));
    });

    well.append(createDbScale(), fader, createLedMeterPair(`ch-${ch.index}`));

    // Footer (Readout + M/S + Scribble Strip)
    const footer = document.createElement('div');
    footer.className = 'strip-footer';

    const rms = document.createElement('div');
    rms.className = 'readout-ms';

    const msBtns = document.createElement('div');
    msBtns.className = 'ms-btns';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'ms-btn mute';
    muteBtn.setAttribute('aria-pressed', String(Boolean(ch.mute)));
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => {
      setChParam(ch.index, 'mute', !ch.mute);
      muteBtn.setAttribute('aria-pressed', String(ch.mute));
    });

    const soloBtn = document.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = 'ms-btn solo';
    soloBtn.setAttribute('aria-pressed', String(Boolean(ch.solo)));
    soloBtn.textContent = 'S';
    soloBtn.addEventListener('click', () => {
      setChParam(ch.index, 'solo', !ch.solo);
      soloBtn.setAttribute('aria-pressed', String(ch.solo));
    });

    msBtns.append(muteBtn, soloBtn);
    rms.append(dbReadout, msBtns);

    const scribble = document.createElement('button');
    scribble.type = 'button';
    scribble.className = 'scribble-strip';
    scribble.textContent = ch.name;
    scribble.addEventListener('click', () => {
      app.state.selectedChannel = ch.index;
      sendWs({ type: 'select_channel', index: ch.index });
      renderConsole();
      renderFatChannel();
    });

    footer.append(rms, scribble);
    strip.append(roleBar, inputBlock, insBlock, sendBlock, panBlock, well, footer);
    dom.consoleRack.append(strip);
  }
}

function renderMasters() {
  if (!app.state) return;
  dom.masterRack.replaceChildren();

  const specs = [
    {
      title: 'STREAM OUT',
      sub: 'OBS / TTLS',
      color: '#10b981',
      dbKey: 'streamMasterDb',
      muteKey: 'streamMasterMute',
      meterPrefix: 'stream',
    },
    {
      title: 'MONITOR OUT',
      sub: 'HEADPHONE',
      color: '#2f9cf4',
      dbKey: 'monitorMasterDb',
      muteKey: 'monitorMasterMute',
      meterPrefix: 'mon',
    },
  ];

  for (const m of specs) {
    const strip = document.createElement('article');
    strip.className = 's1-strip is-master';
    strip.style.setProperty('--ch-color', m.color);

    const roleBar = document.createElement('div');
    roleBar.className = 'strip-top-role';
    roleBar.innerHTML = `<span>${m.sub}</span><span>BUS</span>`;

    const well = document.createElement('div');
    well.className = 'fader-meter-well';

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'v-fader';
    fader.min = '0';
    fader.max = '100';
    fader.value = String(faderToLinearSlider(app.state.globals[m.dbKey]));
    fader.ariaLabel = m.title;
    syncSlider(fader);

    const dbReadout = document.createElement('div');
    dbReadout.className = 'db-readout';
    dbReadout.textContent = formatDb(app.state.globals[m.dbKey]);

    fader.addEventListener('input', () => {
      syncSlider(fader);
      const db = linearSliderToDb(fader.value);
      dbReadout.textContent = formatDb(db);
      setGlobalParam(m.dbKey, db);
    });
    addDoubleTapReset(fader, () => {
      fader.value = String(faderToLinearSlider(0));
      fader.dispatchEvent(new Event('input'));
    });

    well.append(createDbScale(), fader, createLedMeterPair(m.meterPrefix));

    const footer = document.createElement('div');
    footer.className = 'strip-footer';

    const rms = document.createElement('div');
    rms.className = 'readout-ms';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'ms-btn mute';
    muteBtn.setAttribute('aria-pressed', String(Boolean(app.state.globals[m.muteKey])));
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => {
      const next = !app.state.globals[m.muteKey];
      setGlobalParam(m.muteKey, next);
      muteBtn.setAttribute('aria-pressed', String(next));
    });

    rms.append(dbReadout, muteBtn);

    const scribble = document.createElement('div');
    scribble.className = 'scribble-strip';
    scribble.textContent = m.title;

    footer.append(rms, scribble);
    strip.append(roleBar, well, footer);
    dom.masterRack.append(strip);
  }
}

function createFatSlider(label, min, max, step, value, fmt, onChange) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const top = document.createElement('div');
  top.className = 'param-lbl-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const val = document.createElement('strong');
  val.textContent = fmt(value);
  top.append(lbl, val);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'h-mini';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  syncSlider(slider);

  slider.addEventListener('input', () => {
    syncSlider(slider);
    const num = Number(slider.value);
    val.textContent = fmt(num);
    onChange(num);
  });

  row.append(top, slider);
  return row;
}

function renderFatChannel() {
  if (!app.state) return;
  const ch = app.state.channels[app.state.selectedChannel] || app.state.channels[0];
  dom.fatChannelName.textContent = `${ch.name} (${ch.role})`;
  dom.fatBody.replaceChildren();

  // HPF & Gate
  const gateCard = document.createElement('div');
  gateCard.className = 'fat-card';
  gateCard.innerHTML = `<div class="fat-card-head"><span>HPF &amp; Noise Gate</span></div>`;
  gateCard.append(
    createFatSlider('HPF Cut', 20, 300, 1, ch.hpfHz, (v) => `${v} Hz`, (v) => setChParam(ch.index, 'hpfHz', v)),
    createFatSlider('Gate Threshold', -80, -10, 1, ch.gateThreshDb, (v) => `${v} dB`, (v) => setChParam(ch.index, 'gateThreshDb', v)),
  );

  // 3-Band Pro EQ
  const eqCard = document.createElement('div');
  eqCard.className = 'fat-card';
  eqCard.innerHTML = `<div class="fat-card-head"><span>3-Band Pro EQ</span></div>`;
  eqCard.append(
    createFatSlider('Low (120 Hz)', -12, 12, 0.5, ch.eqLowDb, (v) => `${v > 0 ? '+' : ''}${v} dB`, (v) => setChParam(ch.index, 'eqLowDb', v)),
    createFatSlider('Mid (1.2 kHz)', -12, 12, 0.5, ch.eqMidDb, (v) => `${v > 0 ? '+' : ''}${v} dB`, (v) => setChParam(ch.index, 'eqMidDb', v)),
    createFatSlider('High (6.5 kHz)', -12, 12, 0.5, ch.eqHighDb, (v) => `${v > 0 ? '+' : ''}${v} dB`, (v) => setChParam(ch.index, 'eqHighDb', v)),
  );

  // Compressor
  const compCard = document.createElement('div');
  compCard.className = 'fat-card';
  compCard.innerHTML = `<div class="fat-card-head"><span>Vocal Compressor</span><span id="fat-comp-gr" class="badge-val">GR: 0.0 dB</span></div>`;
  compCard.append(
    createFatSlider('Threshold', -45, 0, 1, ch.compThreshDb, (v) => `${v} dB`, (v) => setChParam(ch.index, 'compThreshDb', v)),
    createFatSlider('Ratio', 1, 10, 0.2, ch.compRatio, (v) => `${Number(v).toFixed(1)}:1`, (v) => setChParam(ch.index, 'compRatio', v)),
    createFatSlider('Makeup Gain', 0, 12, 0.5, ch.compMakeupDb, (v) => `+${v} dB`, (v) => setChParam(ch.index, 'compMakeupDb', v)),
  );

  // Stream Auto-Ducking & Reverb
  const streamCard = document.createElement('div');
  streamCard.className = 'fat-card';
  streamCard.innerHTML = `<div class="fat-card-head"><span>Auto-Ducking &amp; Reverb</span></div>`;
  streamCard.append(
    createFatSlider('Ducking Depth', -24, -2, 1, app.state.globals.autoDuckDepthDb, (v) => `${v} dB`, (v) => setGlobalParam('autoDuckDepthDb', v)),
    createFatSlider('Reverb Decay', 0.2, 0.88, 0.02, app.state.globals.reverbDecay, (v) => `${Math.round(v * 100)}%`, (v) => setGlobalParam('reverbDecay', v)),
  );

  dom.fatBody.append(gateCard, eqCard, compCard, streamCard);
}

function flashPad(idx) {
  const btn = document.querySelector(`[data-pad-idx="${idx}"]`);
  if (!btn) return;
  btn.classList.add('is-hit');
  setTimeout(() => btn.classList.remove('is-hit'), 160);
}

function renderPads() {
  if (!app.state) return;
  dom.padsRow.replaceChildren();
  for (const pad of app.state.pads) {
    const cell = document.createElement('div');
    cell.className = 's1-pad';
    cell.style.setProperty('--pad-color', pad.color);

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
    loadBtn.textContent = pad.wavPath ? 'Ganti .WAV' : 'Load .WAV';
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
  renderFatChannel();
  renderPads();
  populateDeviceSelects();
  renderLanList();
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
    await fetch(`/api/upload-wav?pad=${app.uploadPadIdx}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: await file.arrayBuffer(),
    });
  } finally {
    dom.wavUploadInput.value = '';
  }
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
