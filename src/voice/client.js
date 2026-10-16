// Starts the local Python voice sidecar, or reuses one that is already
// listening on 127.0.0.1. The venv and the models live under GIFOS_MCP_HOME.
// Unit tests do not call this; they inject fake speech engines.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';
import { wavFromPcm } from '../audio/wav.js';

const SIDECAR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidecar.py');

let singleton = null;
let starting = null;

function pythonOf(home) {
  if (process.env.GIFOS_VOICE_PYTHON) return process.env.GIFOS_VOICE_PYTHON;
  return path.join(home, 'voice-venv', 'bin', 'python');
}

function enginesImport(py) {
  if (!py || !fs.existsSync(py)) return false;
  const r = spawnSync(py, ['-c', 'import faster_whisper, kokoro_onnx'], { stdio: 'ignore' });
  return r.status === 0;
}

function ensureVenv(home) {
  const forced = process.env.GIFOS_VOICE_PYTHON;
  if (forced) {
    if (!fs.existsSync(forced)) throw new Error('GIFOS_VOICE_PYTHON does not exist');
    return forced;
  }
  const py = pythonOf(home);
  if (enginesImport(py)) return py;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const venv = path.join(home, 'voice-venv');
  if (!fs.existsSync(py)) {
    log('creating the local voice venv');
    const made = spawnSync('python3', ['-m', 'venv', venv], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (!fs.existsSync(py)) {
      // Some images ship a Python with no ensurepip. uv can still build 3.12.
      const uv = spawnSync('uv', ['venv', '--python', '3.12', venv], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (uv.status !== 0 || !fs.existsSync(py)) {
        throw new Error('Could not create the voice venv. Install python3-venv, or set GIFOS_VOICE_PYTHON. ' + (made.stderr || ''));
      }
    }
  }
  log('installing faster-whisper and kokoro-onnx (first use)');
  const pip = spawnSync(py, ['-m', 'pip', 'install', '--disable-pip-version-check', 'faster-whisper', 'kokoro-onnx'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (pip.status !== 0) {
    const uvPip = spawnSync('uv', ['pip', 'install', '--python', py, 'faster-whisper', 'kokoro-onnx'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (uvPip.status !== 0) throw new Error('pip install of faster-whisper and kokoro-onnx failed.');
  }
  return py;
}

function childEnv(home, token, port) {
  const env = { ...process.env, GIFOS_MCP_HOME: home, GIFOS_VOICE_TOKEN: token };
  if (!env.GIFOS_VAD_END_MS) env.GIFOS_VAD_END_MS = '500';
  if (port) env.GIFOS_VOICE_PORT = String(port);
  else delete env.GIFOS_VOICE_PORT;
  const espeak = path.join(home, 'models', 'piper', 'espeak-ng');
  if (fs.existsSync(espeak)) {
    const binDir = path.dirname(espeak);
    env.PATH = binDir + path.delimiter + (env.PATH || '');
    env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? path.delimiter + env.LD_LIBRARY_PATH : '');
    const data = path.join(home, 'models', 'piper', 'espeak-ng-data');
    if (fs.existsSync(data)) env.ESPEAK_DATA_PATH = data;
  }
  return env;
}

function pcmToWav(buf, rate) {
  const n = Math.floor(buf.length / 2);
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) i16[i] = buf.readInt16LE(i * 2);
  return Buffer.from(wavFromPcm(i16, rate, 1));
}

function ndjson(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch (e) { /* ignore a partial line */ }
  }
  return events;
}

export class VoiceClient {
  constructor(baseUrl, token, child, adopted) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.child = child || null;
    this.adopted = !!adopted;
    this.sttId = 'faster-whisper';
    this.ttsId = 'kokoro';
    this.id = this.sttId;
    this.healthBody = null;
  }

  applyHealth(body) {
    this.healthBody = body;
    if (body && body.engines) {
      this.sttId = body.engines.stt || this.sttId;
      this.ttsId = body.engines.tts || this.ttsId;
      this.id = this.sttId;
    }
  }

  headers(extra) {
    return { authorization: 'Bearer ' + this.token, ...extra };
  }

  ttsUrl() {
    return this.baseUrl + '/tts';
  }

  async health() {
    const res = await fetch(this.baseUrl + '/health', { headers: this.headers() });
    if (!res.ok) throw new Error('voice health ' + res.status);
    const body = await res.json();
    this.applyHealth(body);
    return body;
  }

  async transcribe(wav) {
    const t0 = Date.now();
    const res = await fetch(this.baseUrl + '/stt', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'audio/wav' }),
      body: wav,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('stt ' + res.status + ' ' + text.slice(0, 200));
    const events = ndjson(text);
    const final = events.filter((e) => e.final).pop();
    const any = final || events[events.length - 1] || { text: '' };
    return { text: String(any.text || '').trim(), ms: Date.now() - t0, engine: this.sttId, events };
  }

  async pushPcm(streamId, speaker, i16) {
    const buf = Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
    const res = await fetch(this.baseUrl + '/stt', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        stream_id: streamId,
        speaker,
        pcm_b64: buf.toString('base64'),
        rate: 16000,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('stt ' + res.status + ' ' + text.slice(0, 200));
    return ndjson(text);
  }

  async synthesize(text, voice) {
    const res = await fetch(this.ttsUrl(), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text: String(text), voice: voice || '' }),
    });
    if (!res.ok) throw new Error('tts ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const rate = Number(res.headers.get('x-audio-rate') || 24000);
    const buf = Buffer.from(await res.arrayBuffer());
    return pcmToWav(buf, rate);
  }

  async close() {
    if (singleton === this) singleton = null;
    const child = this.child;
    this.child = null;
    if (!child || this.adopted || child.pid == null || child.pid === 1) return;
    let alive = true;
    try { process.kill(child.pid, 0); } catch (e) { alive = false; }
    if (!alive) return;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 700));
    if (child.exitCode == null && child.signalCode == null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
  }
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error('voice sidecar did not become ready. ' + err.slice(-300)));
    }, 12 * 60 * 1000);
    const finish = (fn) => { clearTimeout(timer); fn(); };
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/GIFOS_VOICE_READY (\d+)/);
      if (m) finish(() => resolve(Number(m[1])));
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
      const line = d.toString().trim();
      if (line) log(line.slice(0, 300));
    });
    child.on('exit', (code) => {
      finish(() => reject(new Error('voice sidecar exited ' + code + '. ' + err.slice(-300))));
    });
  });
}

async function spawnVoice(cfg) {
  const home = cfg.home;
  const adopted = await adoptIfUp();
  if (adopted) return adopted;
  const py = ensureVenv(home);
  const token = crypto.randomBytes(24).toString('hex');
  const port = String(process.env.GIFOS_VOICE_PORT || '').trim();
  const env = childEnv(home, token, port && Number(port) > 0 ? port : '');
  const child = spawn(py, [SIDECAR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(child.pid, 15); } catch (e) { /* the shell nice covers this when set */ }
  let bound;
  try {
    bound = await waitReady(child);
  } catch (e) {
    try { child.kill('SIGTERM'); } catch (err) { /* already gone */ }
    throw e;
  }
  const client = new VoiceClient('http://127.0.0.1:' + bound, token, child, false);
  const health = await client.health();
  if (health && health.ok === false && health.error) log('voice self-test: ' + health.error);
  log('voice sidecar 127.0.0.1:' + bound + ' stt=' + client.sttId + ' tts=' + client.ttsId);
  return client;
}

async function adoptIfUp() {
  const port = String(process.env.GIFOS_VOICE_PORT || '').trim();
  const token = String(process.env.GIFOS_VOICE_TOKEN || '').trim();
  if (!port || !token) return null;
  const client = new VoiceClient('http://127.0.0.1:' + port, token, null, true);
  try {
    await client.health();
    log('voice sidecar reused on 127.0.0.1:' + port);
    return client;
  } catch (e) {
    return null;
  }
}

export function sharedVoice(cfg) {
  if (singleton) return Promise.resolve(singleton);
  if (!starting) {
    starting = spawnVoice(cfg).then((client) => {
      singleton = client;
      starting = null;
      return client;
    }).catch((e) => {
      starting = null;
      throw e;
    });
  }
  return starting;
}
