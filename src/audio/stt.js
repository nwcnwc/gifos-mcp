// Speech to text. The default is a local whisper.cpp server (one model load,
// then POST a wav). GIFOS_STT_URL replaces it. Transformers is optional.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { log } from '../log.js';
import { selectStt, sttThreads, isOpenAiTranscriptions } from './engines.js';
import { downloadFile, multipartFile, requestBuf } from './net.js';

const WHISPER_RELEASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/';
const MODEL_URLS = {
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
};

function whisperAsset() {
  if (process.platform !== 'linux') return '';
  if (process.arch === 'x64') return WHISPER_RELEASE + 'whisper-bin-ubuntu-x64.tar.gz';
  if (process.arch === 'arm64') return WHISPER_RELEASE + 'whisper-bin-ubuntu-arm64.tar.gz';
  return '';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(cmd + ' exited ' + code + ' ' + err.slice(-400)));
    });
  });
}

async function ensureWhisperBin(home) {
  if (process.env.GIFOS_WHISPER_BIN && fs.existsSync(process.env.GIFOS_WHISPER_BIN)) {
    return process.env.GIFOS_WHISPER_BIN;
  }
  const candidates = [
    path.join(home, 'models', 'whisper.cpp', 'whisper-cli'),
    path.join(home, 'models', 'whisper-x64', 'whisper-cli'),
    path.join(home, 'models', 'whisper-arm64', 'whisper-cli'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const url = whisperAsset();
  if (!url) throw new Error('No whisper.cpp build for ' + process.platform + '/' + process.arch + '. Set GIFOS_WHISPER_BIN or GIFOS_STT_URL.');
  const archive = path.join(home, 'models', 'whisper-bin.tar.gz');
  await downloadFile(url, archive, { minBytes: 100000, log });
  const dest = path.join(home, 'models', 'whisper.cpp');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  await run('tar', ['-xzf', archive, '-C', dest, '--strip-components=1']);
  const bin = path.join(dest, 'whisper-cli');
  if (!fs.existsSync(bin)) throw new Error('whisper.cpp archive had no whisper-cli');
  return bin;
}

async function ensureWhisperModel(home, model) {
  if (process.env.GIFOS_WHISPER_MODEL && fs.existsSync(process.env.GIFOS_WHISPER_MODEL)) {
    return process.env.GIFOS_WHISPER_MODEL;
  }
  const name = MODEL_URLS[model] ? model : 'base.en';
  const dest = path.join(home, 'models', 'ggml-' + name + '-q5_1.bin');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000000) return dest;
  await downloadFile(MODEL_URLS[name], dest, { minBytes: 1000000, log });
  return dest;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function postInference(url, wav) {
  const mp = multipartFile(wav, { filename: 'audio.wav', type: 'audio/wav', fields: { response_format: 'json' } });
  const res = await requestBuf(url, {
    method: 'POST',
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
    timeout: 120000,
  });
  if (res.status >= 300) throw new Error('stt ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200));
  const j = JSON.parse(res.body.toString('utf8') || '{}');
  return String(j.text || '').trim();
}

class WhisperCpp {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.url = '';
    this.starting = null;
    this.id = 'whisper.cpp';
  }

  ensure() {
    if (this.url) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().then(() => { this.starting = null; }, (e) => { this.starting = null; throw e; });
    }
    return this.starting;
  }

  async start() {
    const home = this.cfg.home;
    const threads = sttThreads(process.env);
    const choice = selectStt(process.env);
    const bin = await ensureWhisperBin(home);
    const model = await ensureWhisperModel(home, choice.model || 'base.en');
    const server = path.join(path.dirname(bin), 'whisper-server');
    const port = await freePort();
    const args = [
      '-m', model, '-t', String(threads), '-ng', '-nfa', '-l', 'en', '-sns', '-bs', '1',
      '--host', '127.0.0.1', '--port', String(port),
    ];
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: path.dirname(bin) + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
      OMP_NUM_THREADS: String(threads),
    };
    const cmd = fs.existsSync(server) ? server : bin;
    const cmdArgs = fs.existsSync(server) ? args : null;
    if (!cmdArgs) throw new Error('whisper-server is missing next to ' + bin);
    log('stt whisper.cpp ' + path.basename(model) + ' threads=' + threads + ' on 127.0.0.1:' + port);
    const child = spawn('nice', ['-n', '15', cmd, ...cmdArgs], {
      env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let logBuf = '';
    child.stderr.on('data', (c) => { logBuf = (logBuf + c.toString()).slice(-2000); });
    child.stdout.on('data', (c) => { logBuf = (logBuf + c.toString()).slice(-2000); });
    child.on('exit', (code) => {
      if (this.child === child) { this.child = null; this.url = ''; }
      if (code) log('whisper-server exited ' + code + ' ' + logBuf.slice(-300));
    });
    const url = 'http://127.0.0.1:' + port + '/inference';
    const t0 = Date.now();
    let lastErr = '';
    while (Date.now() - t0 < 60000) {
      if (!this.child) throw new Error('whisper-server exited before it listened. ' + logBuf.slice(-300));
      try {
        const ping = await requestBuf('http://127.0.0.1:' + port + '/', { timeout: 1000 });
        if (ping.status < 500) { this.url = url; this.model = model; return; }
      } catch (e) { lastErr = e.message; }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('whisper-server did not listen: ' + (lastErr || logBuf.slice(-200)));
  }

  async transcribe(wav) {
    await this.ensure();
    const t0 = Date.now();
    const text = await postInference(this.url, wav);
    return { text, ms: Date.now() - t0, engine: this.id };
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.url = '';
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} r(); }, 1500);
      child.on('exit', () => { clearTimeout(t); r(); });
    });
  }
}

class HttpStt {
  constructor(choice) {
    this.url = choice.url;
    this.openai = choice.openai;
    this.id = 'http';
  }
  async transcribe(wav) {
    const t0 = Date.now();
    let text = '';
    if (this.openai) {
      const mp = multipartFile(wav, { filename: 'audio.wav', type: 'audio/wav', fields: { model: 'whisper-1' } });
      const res = await requestBuf(this.url, {
        method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body, timeout: 120000,
      });
      if (res.status >= 300) throw new Error('stt ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200));
      text = String((JSON.parse(res.body.toString('utf8') || '{}').text) || '').trim();
    } else {
      const res = await requestBuf(this.url, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, timeout: 120000,
      });
      if (res.status >= 300) throw new Error('stt ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200));
      const raw = res.body.toString('utf8');
      try { text = String(JSON.parse(raw).text || '').trim(); }
      catch (e) { text = raw.trim(); }
    }
    return { text, ms: Date.now() - t0, engine: this.id };
  }
  async close() {}
}

class TransformersStt {
  constructor(env) {
    this.model = selectStt(env).model;
    this.pipe = null;
    this.id = 'transformers';
  }
  async ensure() {
    if (this.pipe) return;
    let transformers;
    try { transformers = await import('@huggingface/transformers'); }
    catch (e) { throw new Error('GIFOS_STT_ENGINE=transformers needs the optional package @huggingface/transformers. ' + e.message); }
    const threads = sttThreads(process.env);
    process.env.OMP_NUM_THREADS = String(threads);
    log('stt transformers ' + this.model + ' (first run downloads the model)');
    this.pipe = await transformers.pipeline('automatic-speech-recognition', this.model, { dtype: 'q8', device: 'cpu' });
  }
  async transcribe(wav) {
    await this.ensure();
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-stt-'));
    const file = path.join(dir, 'in.wav');
    fs.writeFileSync(file, wav);
    try {
      const out = await this.pipe(file);
      const text = String((out && out.text) || '').trim();
      return { text, ms: Date.now() - t0, engine: this.id };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  async close() { this.pipe = null; }
}

export function createStt(cfg, env = process.env) {
  const choice = selectStt(env);
  if (choice.id === 'http') return new HttpStt(choice);
  if (choice.id === 'transformers') return new TransformersStt(env);
  if (choice.id === 'whisper.cpp') return new WhisperCpp(cfg);
  throw new Error('The default speech engine is faster-whisper in the local voice sidecar. Set GIFOS_STT=whisper.cpp to use the optional whisper.cpp engine.');
}

export { isOpenAiTranscriptions, postInference };
