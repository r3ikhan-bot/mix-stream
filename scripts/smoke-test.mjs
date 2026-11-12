import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = path.resolve(path.dirname(__filename), '..');
const PORT = Number(process.env.SMOKE_PORT || 18785);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STATE_FILE = path.join(os.tmpdir(), `ssm_smoke_${process.pid}.json`);

async function waitForEngineReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/info`);
      if (res.ok) {
        const info = await res.json();
        if (info.status && info.status.running) return info;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server / engine did not become ready on /api/info in time');
}

async function main() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}

  const serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STATE_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  serverProc.stderr.on('data', (d) => (stderrBuf += d.toString()));

  try {
    const info = await waitForEngineReady();
    assert.equal(info.status.running, true, 'Audio engine should be running');
    assert.ok(Array.isArray(info.devices), 'Missing devices array');

    const htmlRes = await fetch(`${BASE_URL}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('StudioStream'), 'Expected StudioStream title in index.html');

    const devRes = await fetch(`${BASE_URL}/api/devices`);
    assert.equal(devRes.status, 200);

    console.log('[OK] Cross-platform smoke test passed:', JSON.stringify(info.status));
  } finally {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {}
    if (stderrBuf.trim()) {
      console.error('Server stderr:', stderrBuf);
    }
  }
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
