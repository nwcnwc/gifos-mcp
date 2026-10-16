// Text to speech. Default is Piper (voice downloaded on first use into
// GIFOS_MCP_HOME/models). GIFOS_TTS_URL replaces it. espeak-ng is the fallback
// when it is on PATH (Piper also ships a copy). kokoro-js is optional.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from '../log.js';
import { selectTts } from './engines.js';
import { downloadFile, looksAudio, requestBuf } from './net.js';

const PIPER_VOICE = 'en_US-lessac-medium';
const PIPER_VOICE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/' + PIPER_VOICE;

function piperAsset() {
  if (process.platform !== 'linux') return '';
  if (process.arch === 'x64') return 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
  if (process.arch === 'arm64') return 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz';
  return '';
}

function runCapture(cmd, args, { input, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new Error(cmd + ' exited ' + code + ' ' + stderr.slice(-400)));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function which(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const name of names) {
    if (name.includes(path.sep) && fs.existsSync(name)) return name;
    for (const d of dirs) {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

async function ensurePiper(home) {
  if (process.env.GIFOS_PIPER_BIN && fs.existsSync(process.env.GIFOS_PIPER_BIN)) return process.env.GIFOS_PIPER_BIN;
  const local = path.join(home, 'models', 'piper', 'piper');
  if (fs.existsSync(local)) return local;
  const url = piperAsset();
  if (!url) throw new Error('No Piper build for ' + process.platform + '/' + process.arch + '. Set GIFOS_PIPER_BIN or GIFOS_TTS_URL.');
  const archive = path.join(home, 'models', 'piper.tar.gz');
  await downloadFile(url, archive, { minBytes: 100000, log });
  const dest = path.join(home, 'models', 'piper');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  await runCapture('tar', ['-xzf', archive, '-C', dest, '--strip-components=1']);
  if (!fs.existsSync(local)) throw new Error('Piper archive had no piper binary');
  return local;
}

async function ensureVoice(home, voice) {
  if (voice && fs.existsSync(voice)) return voice;
  if (process.env.GIFOS_TTS_VOICE && fs.existsSync(process.env.GIFOS_TTS_VOICE)) return process.env.GIFOS_TTS_VOICE;
  const dest = path.join(home, 'models', PIPER_VOICE + '.onnx');
  const json = dest + '.json';
  if (!fs.existsSync(dest)) await downloadFile(PIPER_VOICE_URL + '.onnx', dest, { minBytes: 100000, log });
  if (!fs.existsSync(json)) await downloadFile(PIPER_VOICE_URL + '.onnx.json', json, { minBytes: 100, log });
  return dest;
}

function findEspeak(home) {
  return which(['espeak-ng', 'espeak']) || (() => {
    const bundled = path.join(home, 'models', 'piper', 'espeak-ng');
    return fs.existsSync(bundled) ? bundled : '';
  })();
}

class PiperTts {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = 'piper';
    this.ready = null;
  }
  async synthesize(text, voice) {
    if (!this.ready) this.ready = Promise.all([ensurePiper(this.cfg.home), ensureVoice(this.cfg.home, voice)]).catch((e) => { this.ready = null; throw e; });
    let bin, model;
    try { [bin, model] = await this.ready; }
    catch (e) {
      const es = findEspeak(this.cfg.home);
      if (!es) throw e;
      log('piper failed (' + e.message + '); using espeak-ng');
      return espeakSpeak(es, text);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-tts-'));
    const out = path.join(dir, 'out.wav');
    try {
      await runCapture(bin, ['--model', model, '--output_file', out], {
        input: String(text),
        env: {
          ...process.env,
          LD_LIBRARY_PATH: path.dirname(bin) + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
          ESPEAK_DATA_PATH: path.join(path.dirname(bin), 'espeak-ng-data'),
        },
      });
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function espeakSpeak(bin, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-tts-'));
  const out = path.join(dir, 'out.wav');
  const env = { ...process.env };
  const data = path.join(path.dirname(bin), 'espeak-ng-data');
  if (fs.existsSync(data)) env.ESPEAK_DATA_PATH = data;
  if (fs.existsSync(path.join(path.dirname(bin), 'libespeak-ng.so.1'))) {
    env.LD_LIBRARY_PATH = path.dirname(bin) + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  }
  return runCapture(bin, ['-w', out, '-s', '150', String(text)], { env }).then(() => {
    try { return fs.readFileSync(out); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

class EspeakTts {
  constructor(cfg) { this.cfg = cfg; this.id = 'espeak'; }
  async synthesize(text) {
    const bin = findEspeak(this.cfg.home);
    if (!bin) throw new Error('espeak-ng is not installed and Piper is not selected.');
    return espeakSpeak(bin, text);
  }
}

class KokoroTts {
  constructor() { this.id = 'kokoro'; this.tts = null; }
  async synthesize(text, voice) {
    if (!this.tts) {
      let mod;
      try { mod = await import('kokoro-js'); }
      catch (e) { throw new Error('GIFOS_TTS_ENGINE=kokoro needs the optional package kokoro-js. ' + e.message); }
      log('tts kokoro (first run downloads the model)');
      this.tts = await mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' });
    }
    const audio = await this.tts.generate(String(text), { voice: voice || 'af_heart' });
    if (audio && typeof audio.toWav === 'function') return Buffer.from(audio.toWav());
    if (audio && audio.audio) return Buffer.from(audio.audio);
    throw new Error('kokoro-js returned no audio');
  }
}

function audioFromJson(buf, baseUrl) {
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  const b64 = j && (j.audio || j.b64 || j.base64);
  if (typeof b64 === 'string' && b64) return Buffer.from(b64, 'base64');
  if (j && typeof j.url === 'string') return j.url.startsWith('http') ? j.url : new URL(j.url, baseUrl).toString();
  return null;
}

class HttpTts {
  constructor(choice) { this.url = choice.url; this.openai = choice.openai; this.id = 'http'; }
  async synthesize(text, voice) {
    const body = this.openai
      ? { model: 'tts-1', input: String(text), voice: voice || 'alloy' }
      : { text: String(text), voice: voice || '' };
    const res = await requestBuf(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(body)),
      timeout: 120000,
    });
    if (res.status >= 300) throw new Error('tts ' + res.status + ' ' + res.body.toString('utf8').slice(0, 200));
    const ct = res.headers['content-type'] || '';
    if (looksAudio(res.body, ct)) return res.body;
    const parsed = audioFromJson(res.body, this.url);
    if (Buffer.isBuffer(parsed)) return parsed;
    if (typeof parsed === 'string') {
      const got = await requestBuf(parsed, { timeout: 120000 });
      if (got.status >= 300 || !looksAudio(got.body, got.headers['content-type'])) throw new Error('tts url did not return audio');
      return got.body;
    }
    throw new Error('tts response was not audio');
  }
}

export function createTts(cfg, env = process.env) {
  const choice = selectTts(env);
  if (choice.id === 'http') return new HttpTts(choice);
  if (choice.id === 'kokoro') return new KokoroTts();
  if (choice.id === 'espeak') return new EspeakTts(cfg);
  return new PiperTts(cfg);
}
