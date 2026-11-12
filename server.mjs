import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultState } from './lib/default-state.mjs';
import { WebSocketHub } from './lib/ws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENGINE_DIR = path.join(__dirname, 'engine');
const BUILD_DIR = path.join(__dirname, 'build');
const SAMPLES_DIR = path.join(__dirname, 'samples');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ENGINE_BIN = path.join(BUILD_DIR, IS_WIN ? 'studio-stream-engine.exe' : 'studio-stream-engine');
const DESKTOP_BIN = path.join(BUILD_DIR, 'StudioStreamDesktop');

const PORT = Number(process.env.PORT || 8780);
const HOST = process.env.HOST || '0.0.0.0';
const LAUNCH_DESKTOP = process.argv.includes('--desktop');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const PREBUILT_MARKER = path.join(BUILD_DIR, '.prebuilt');
const FORCE_REBUILD = process.env.FORCE_REBUILD === '1';

function ensureBinaries() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });

  const isPrebuilt = fs.existsSync(PREBUILT_MARKER) && !FORCE_REBUILD;

  const engineSources = [
    path.join(ENGINE_DIR, 'main.cpp'),
    path.join(ENGINE_DIR, IS_WIN ? 'WinAudioBackend.cpp' : 'MacAudioBackend.cpp'),
    path.join(ENGINE_DIR, 'MixerEngine.hpp'),
    path.join(ENGINE_DIR, 'DspMath.hpp'),
    path.join(ENGINE_DIR, 'Soundboard.hpp'),
    path.join(ENGINE_DIR, 'AudioBackend.hpp'),
  ];

  let needsEngineBuild = !fs.existsSync(ENGINE_BIN);
  if (!needsEngineBuild && !isPrebuilt) {
    const binMtime = fs.statSync(ENGINE_BIN).mtimeMs;
    needsEngineBuild = engineSources.some((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > binMtime);
  }

  if (needsEngineBuild) {
    console.log('[Engine] Compiling C++ DSP audio engine...');
    if (IS_MAC) {
      execFileSync(
        'clang++',
        [
          '-std=c++17',
          '-O2',
          '-framework', 'CoreAudio',
          '-framework', 'AudioToolbox',
          '-framework', 'CoreFoundation',
          path.join(ENGINE_DIR, 'main.cpp'),
          path.join(ENGINE_DIR, 'MacAudioBackend.cpp'),
          '-o', ENGINE_BIN,
        ],
        { stdio: 'inherit' },
      );
    } else if (IS_WIN) {
      try {
        execFileSync(
          'g++',
          [
            '-std=c++17',
            '-O2',
            path.join(ENGINE_DIR, 'main.cpp'),
            path.join(ENGINE_DIR, 'WinAudioBackend.cpp'),
            '-lole32',
            '-luuid',
            '-lavrt',
            '-lmmdevapi',
            '-o', ENGINE_BIN,
          ],
          { stdio: 'inherit' },
        );
      } catch {
        execFileSync(
          'cl',
          [
            '/std:c++17',
            '/O2',
            '/EHsc',
            path.join(ENGINE_DIR, 'main.cpp'),
            path.join(ENGINE_DIR, 'WinAudioBackend.cpp'),
            `/Fe:${ENGINE_BIN}`,
            'ole32.lib',
            'uuid.lib',
            'avrt.lib',
            'mmdevapi.lib',
          ],
          { stdio: 'inherit' },
        );
      }
    }
  }

  if (IS_MAC && LAUNCH_DESKTOP) {
    const desktopSrc = path.join(__dirname, 'desktop', 'MacWindow.swift');
    let needsDesktop = !fs.existsSync(DESKTOP_BIN);
    if (!needsDesktop && !isPrebuilt && fs.statSync(desktopSrc).mtimeMs > fs.statSync(DESKTOP_BIN).mtimeMs) {
      needsDesktop = true;
    }
    if (needsDesktop) {
      console.log('[Desktop] Compiling native macOS Studio One shell...');
      execFileSync(
        'swiftc',
        [
          '-O',
          '-framework', 'AVFoundation',
          '-framework', 'Cocoa',
          '-framework', 'WebKit',
          desktopSrc,
          '-o',
          DESKTOP_BIN,
        ],
        { stdio: 'inherit' },
      );
    }
  }
}

class AudioEngineProcess {
  constructor(binPath, onEvent) {
    this.binPath = binPath;
    this.onEvent = onEvent;
    this.proc = null;
    this.devices = [];
    this.status = { running: false, sampleRate: 48000, text: 'Starting...' };
    this.stopping = false;
    this.lineBuf = '';
  }

  start(initialState) {
    this.stopping = false;
    this.proc = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => {
      this.lineBuf += chunk;
      let idx;
      while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
        const line = this.lineBuf.slice(0, idx).trim();
        this.lineBuf = this.lineBuf.slice(idx + 1);
        if (!line) continue;
        this.#handleLine(line, initialState);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const msg = chunk.trim();
      if (msg) console.error(`[Engine stderr] ${msg}`);
    });

    this.proc.on('exit', (code) => {
      if (!this.stopping) {
        console.error(`[Engine] Exited (${code}), restarting in 1s...`);
        setTimeout(() => this.start(initialState), 1000);
      }
    });
  }

  #handleLine(line, stateRef) {
    if (line.startsWith('READY')) {
      this.syncAll(stateRef());
      return;
    }
    if (line.startsWith('DEVICES ')) {
      try {
        this.devices = JSON.parse(line.slice(8));
        this.onEvent({ type: 'devices', devices: this.devices });
      } catch {}
      return;
    }
    if (line.startsWith('STATUS ')) {
      try {
        this.status = JSON.parse(line.slice(7));
        this.onEvent({ type: 'audio_status', status: this.status });
      } catch {}
      return;
    }
    if (line.startsWith('METERS ')) {
      try {
        const meters = JSON.parse(line.slice(7));
        this.onEvent({ type: 'meters', meters });
      } catch {}
    }
  }

  sendCmd(cmd) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${cmd}\n`);
  }

  setChannelParam(idx, key, value) {
    const numVal = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
    if (!Number.isFinite(numVal)) return;
    this.sendCmd(`CH\t${idx}\t${key}\t${numVal}`);
  }

  setGlobalParam(key, value) {
    const numVal = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
    if (!Number.isFinite(numVal)) return;
    this.sendCmd(`GLOBAL\t${key}\t${numVal}`);
  }

  startAudio(cfg) {
    this.sendCmd(
      `START\t${cfg.inputDevId || 'default'}\t${cfg.musicInputDevId || 'none'}\t${cfg.monitorOutDevId || 'default'}\t${cfg.streamOutDevId || 'none'}\t${cfg.bufferSize || 256}`,
    );
  }

  listDevices() {
    this.sendCmd('LIST_DEVICES');
  }

  triggerPad(index, gainDb = 0) {
    this.sendCmd(`PAD_TRIGGER\t${index}\t${gainDb}`);
  }

  stopAllPads() {
    this.sendCmd('PAD_STOP_ALL');
  }

  loadPadWav(index, wavPath, label) {
    this.sendCmd(`PAD_LOAD\t${index}\t${wavPath}\t${label}`);
  }

  loadBgmWav(wavPath) {
    this.sendCmd(`BGM_LOAD\t${wavPath}`);
  }

  restartBgm() {
    this.sendCmd('BGM_RESTART');
  }

  syncAll(state) {
    const chKeys = [
      'trimDb', 'phaseInvert', 'hpfOn', 'hpfHz', 'gateOn', 'gateThreshDb',
      'eqOn', 'eqLowDb', 'eqMidHz', 'eqMidDb', 'eqHighDb', 'compOn', 'compThreshDb',
      'compRatio', 'compMakeupDb', 'reverbSend', 'pan', 'faderDb', 'mute',
      'solo', 'routeStream', 'routeMonitor', 'duckRole', 'testTone',
      'inputChannelOffset', 'stereoInput', 'sourceMode',
      'insertA', 'insertAParam1', 'insertAParam2', 'insertB', 'insertBParam1', 'insertBParam2',
    ];
    for (const ch of state.channels) {
      for (const k of chKeys) {
        if (ch[k] !== undefined) this.setChannelParam(ch.index, k, ch[k]);
      }
    }
    for (const [k, v] of Object.entries(state.globals)) {
      this.setGlobalParam(k, v);
    }
    for (const pad of state.pads) {
      if (pad.wavPath && fs.existsSync(pad.wavPath)) {
        this.loadPadWav(pad.index, pad.wavPath, pad.name);
      }
    }
    if (state.bgm && state.bgm.wavPath && fs.existsSync(state.bgm.wavPath)) {
      this.loadBgmWav(state.bgm.wavPath);
    }
    if (state.audioConfig) {
      this.startAudio(state.audioConfig);
    }
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      this.sendCmd('QUIT');
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
      }, 300);
    }
  }
}

function getLanUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const [iface, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push({ iface, ip: info.address, url: `http://${info.address}:${port}` });
      }
    }
  }
  return urls;
}

function loadState() {
  const defaults = createDefaultState();
  try {
    if (!fs.existsSync(STATE_FILE)) return defaults;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!saved || !Array.isArray(saved.channels) || saved.channels.length !== defaults.channels.length) {
      return defaults;
    }
    return {
      ...defaults,
      ...saved,
      audioConfig: { ...defaults.audioConfig, ...(saved.audioConfig || {}) },
      bgm: { ...defaults.bgm, ...(saved.bgm || {}) },
      globals: { ...defaults.globals, ...(saved.globals || {}) },
      channels: defaults.channels.map((defCh, i) => ({
        ...defCh,
        ...(saved.channels[i] || {}),
        sourceMode: saved.channels[i]?.sourceMode ?? defCh.sourceMode,
      })),
    };
  } catch {
    return defaults;
  }
}

let saveTimer = null;
function scheduleSave(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }, 250);
}

function readBinaryBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('File terlalu besar (maks 12 MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

ensureBinaries();
let appState = loadState();
const wsHub = new WebSocketHub();

const engine = new AudioEngineProcess(ENGINE_BIN, (evt) => {
  wsHub.broadcast(evt);
});
engine.start(() => appState);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        status: engine.status,
        devices: engine.devices,
        lanUrls: getLanUrls(PORT),
        clients: wsHub.clients.size,
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/devices') {
    engine.listDevices();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ devices: engine.devices }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    appState = createDefaultState();
    scheduleSave(appState);
    engine.syncAll(appState);
    wsHub.broadcast({ type: 'full_state', state: appState });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload-wav') {
    try {
      const padIdx = Number(url.searchParams.get('pad'));
      const rawName = (url.searchParams.get('name') || `Pad ${padIdx + 1}`).replace(/\.wav$/i, '').slice(0, 20);
      if (!Number.isInteger(padIdx) || padIdx < 0 || padIdx >= appState.pads.length) {
        throw new Error('Pad index tidak valid.');
      }
      const buf = await readBinaryBody(req);
      const dest = path.join(SAMPLES_DIR, `pad_${padIdx}.wav`);
      fs.writeFileSync(dest, buf);
      appState.pads[padIdx].wavPath = dest;
      appState.pads[padIdx].name = rawName;
      scheduleSave(appState);
      engine.loadPadWav(padIdx, dest, rawName);
      wsHub.broadcast({ type: 'full_state', state: appState });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name: rawName }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload-bgm') {
    try {
      const rawName = (url.searchParams.get('name') || 'Background Music').replace(/\.[^.]+$/, '').slice(0, 36);
      const buf = await readBinaryBody(req, 64 * 1024 * 1024);
      const dest = path.join(SAMPLES_DIR, 'bgm_track.wav');
      fs.writeFileSync(dest, buf);
      appState.bgm = { trackName: rawName, wavPath: dest };
      appState.globals.bgmPlaying = true;
      scheduleSave(appState);
      engine.loadBgmWav(dest);
      engine.setGlobalParam('bgmPlaying', true);
      wsHub.broadcast({ type: 'full_state', state: appState });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name: rawName }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  let relPath = url.pathname === '/' ? '/index.html' : url.pathname;
  relPath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('upgrade', (req, socket) => {
  wsHub.handleUpgrade(
    req,
    socket,
    (client, raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ch_param': {
          const ch = appState.channels[msg.index];
          if (!ch) return;
          ch[msg.key] = msg.value;
          engine.setChannelParam(ch.index, msg.key, msg.value);
          scheduleSave(appState);
          wsHub.broadcast({ type: 'ch_update', index: ch.index, key: msg.key, value: msg.value }, client);
          break;
        }
        case 'global_param': {
          appState.globals[msg.key] = msg.value;
          engine.setGlobalParam(msg.key, msg.value);
          scheduleSave(appState);
          wsHub.broadcast({ type: 'global_update', key: msg.key, value: msg.value }, client);
          break;
        }
        case 'pad_trigger': {
          const pad = appState.pads[msg.index];
          if (!pad) return;
          engine.triggerPad(pad.index, pad.gainDb || 0);
          wsHub.broadcast({ type: 'pad_hit', index: pad.index }, client);
          break;
        }
        case 'pad_stop_all': {
          engine.stopAllPads();
          break;
        }
        case 'bgm_restart': {
          engine.restartBgm();
          break;
        }
        case 'recall_scene': {
          const scene = appState.scenes.find((s) => s.id === msg.sceneId);
          if (!scene) return;
          appState.activeSceneId = scene.id;
          appState.globals.autoDuckEnabled = scene.autoDuckEnabled;
          appState.globals.autoDuckDepthDb = scene.autoDuckDepthDb;
          scene.faders.forEach((f, idx) => {
            if (appState.channels[idx]) appState.channels[idx].faderDb = f;
          });
          scene.mutes.forEach((m, idx) => {
            if (appState.channels[idx]) appState.channels[idx].mute = m;
          });
          scene.reverbSends.forEach((r, idx) => {
            if (appState.channels[idx]) appState.channels[idx].reverbSend = r;
          });
          engine.syncAll(appState);
          scheduleSave(appState);
          wsHub.broadcast({ type: 'full_state', state: appState });
          break;
        }
        case 'audio_config': {
          appState.audioConfig = { ...appState.audioConfig, ...msg.config };
          engine.startAudio(appState.audioConfig);
          scheduleSave(appState);
          wsHub.broadcast({ type: 'full_state', state: appState }, client);
          break;
        }
        case 'refresh_devices': {
          engine.listDevices();
          break;
        }
        case 'select_channel': {
          appState.selectedChannel = msg.index;
          wsHub.broadcast({ type: 'selected_channel', index: msg.index }, client);
          break;
        }
        case 'rename_channel': {
          const ch = appState.channels[msg.index];
          if (!ch) return;
          if (msg.name) ch.name = String(msg.name).slice(0, 18);
          if (msg.color) ch.color = msg.color;
          scheduleSave(appState);
          wsHub.broadcast({ type: 'full_state', state: appState });
          break;
        }
        case 'ping': {
          client.send({ type: 'pong', ts: msg.ts });
          break;
        }
        default:
          break;
      }
    },
    (client) => {
      client.send({
        type: 'init',
        state: appState,
        devices: engine.devices,
        audioStatus: engine.status,
        lanUrls: getLanUrls(PORT),
      });
    },
  );
});

let desktopProc = null;

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} sedang dipakai oleh StudioStream instance lain.`);
    engine.stop();
    if (IS_MAC && LAUNCH_DESKTOP && fs.existsSync(DESKTOP_BIN)) {
      desktopProc = spawn(DESKTOP_BIN, [`http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
      desktopProc.on('exit', () => process.exit(0));
      return;
    }
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('\n===============================================================');
  console.log(' StudioStream Mixer — Fender Studio One–style OBS/TTLS Console');
  console.log('===============================================================');
  console.log(` Desktop UI   : http://127.0.0.1:${PORT}`);
  const lan = getLanUrls(PORT);
  for (const l of lan) {
    console.log(` Mobile HP    : ${l.url}  (${l.iface})`);
  }
  console.log('===============================================================\n');

  if (IS_MAC && LAUNCH_DESKTOP && fs.existsSync(DESKTOP_BIN)) {
    desktopProc = spawn(DESKTOP_BIN, [`http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
    desktopProc.on('exit', () => shutdown());
  }
});

function shutdown() {
  engine.stop();
  if (desktopProc && !desktopProc.killed) desktopProc.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
