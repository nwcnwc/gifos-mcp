// Kokoro runs in this process, on the machine that runs gifos-mcp.
// The first call downloads the weights and the af_heart voice into
// GIFOS_MCP_HOME/kokoro. Nothing here is a provider GIF, and nothing
// listens on the network. The headless harness turns speak() into the
// bytes for the tts role. See docs/MEETBOT-BRIDGE.md.
import fs from 'node:fs';
import path from 'node:path';
import { MCP_TTS_APP, KOKORO_VOICE } from './settings.js';
import { nativeVoice } from './voices.js';
import { log } from '../log.js';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_DTYPE = 'q8';

const loads = new Map();

export const KOKORO_HOST = 'https://huggingface.co';

// host is a mirror of the Hugging Face layout (GIFOS_KOKORO_URL); empty means huggingface.co.
export function installKokoro({ home, voice, host } = {}) {
  if (!home) throw new Error('Kokoro needs a directory to keep its weights.');
  const dir = path.join(home, 'kokoro');
  let pending = loads.get(dir);
  if (!pending) {
    pending = load(dir, voice || KOKORO_VOICE, host || KOKORO_HOST).catch((e) => {
      loads.delete(dir);
      throw e;
    });
    loads.set(dir, pending);
  }
  return pending;
}

// transformers.js writes a download straight to its final path, so a run
// killed halfway leaves a short file it trusts on every later start. This
// cache writes <file>.<pid>.part and renames it into place when the bytes
// are all there. Several workers can fetch the same file at once: each
// writes its own part file and the last rename wins with a whole file.
// Keys are the remote URLs; files keep the old <model>/<file> layout, so
// weights downloaded before this change are still found.
export function weightsCache(dir, host) {
  const base = String(host).replace(/\/+$/, '') + '/';
  const fileFor = (key) => {
    const k = String(key);
    if (!k.startsWith(base)) return null;
    const m = /^([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(decodeURIComponent(k.slice(base.length)));
    if (!m) return null;
    const file = path.resolve(dir, m[1], m[2]);
    return file.startsWith(path.resolve(dir) + path.sep) ? file : null;
  };
  return {
    async match(key) {
      const file = fileFor(key);
      if (!file || !fs.existsSync(file)) return undefined;
      const bytes = await fs.promises.readFile(file);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    },
    async put(key, response, progress) {
      const file = fileFor(key);
      if (!file) return;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const part = file + '.' + process.pid + '.part';
      const total = parseInt(response.headers.get('content-length') || '0', 10);
      const out = fs.createWriteStream(part);
      try {
        const reader = response.body.getReader();
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise((resolve, reject) => out.write(value, (e) => (e ? reject(e) : resolve())));
          loaded += value.length;
          if (progress) progress({ progress: total ? (loaded / total) * 100 : 0, loaded, total });
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        if (total && loaded !== total) throw new Error('Kokoro: ' + path.basename(file) + ' ended at ' + loaded + ' of ' + total + ' bytes.');
        await fs.promises.rename(part, file);
      } catch (e) {
        out.destroy();
        await fs.promises.rm(part, { force: true });
        throw e;
      }
    },
  };
}

// Part files left by a process that was killed while downloading.
function dropDeadParts(dir) {
  if (!fs.existsSync(dir)) return;
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const m = /\.(\d+)\.part$/.exec(String(rel));
    if (!m) continue;
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive || Number(m[1]) === process.pid) fs.rmSync(path.join(dir, String(rel)), { force: true });
  }
}

// phonemizer (inside kokoro-js) installs process handlers that rethrow any
// uncaught error from inside the handler: the process then dies with exit 7
// and prints the minified phonemizer source. Keep Node's own handling.
async function importKokoro() {
  const kinds = ['uncaughtException', 'unhandledRejection'];
  const before = new Map(kinds.map((k) => [k, process.listeners(k)]));
  const mod = await import('kokoro-js');
  for (const k of kinds) {
    for (const fn of process.listeners(k)) if (!before.get(k).includes(fn)) process.removeListener(k, fn);
  }
  return mod;
}

async function load(dir, voice, host) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = dir;
  transformers.env.remoteHost = String(host).replace(/\/+$/, '') + '/';
  transformers.env.useCustomCache = true;
  transformers.env.customCache = weightsCache(dir, host);
  const { KokoroTTS } = await importKokoro();
  const modelDir = path.join(dir, ...KOKORO_MODEL.split('/'));
  dropDeadParts(modelDir);
  log('Kokoro: loading ' + KOKORO_MODEL + ' (' + KOKORO_DTYPE + ') into ' + dir);
  const seen = new Set();
  const open = () => KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: KOKORO_DTYPE,
    device: 'cpu',
    progress_callback: (p) => {
      if (!p || p.status !== 'progress' || p.progress == null) return;
      const n = Math.round(p.progress);
      if (n !== 0 && n !== 100) return;
      const name = String(p.file || p.name || 'weights');
      const key = name + ':' + n;
      if (seen.has(key)) return;
      seen.add(key);
      log('Kokoro: ' + name + ' ' + n + '%');
    },
  });
  let tts;
  try {
    tts = await open();
  } catch (first) {
    // A short or corrupt file from an older run: fetch the weights once more.
    log('Kokoro: the weights in ' + modelDir + ' did not load (' + oneLine(first) + '); downloading them again');
    fs.rmSync(modelDir, { recursive: true, force: true });
    seen.clear();
    try {
      tts = await open();
    } catch (again) {
      throw new Error('Kokoro could not load from ' + host + ' into ' + dir + ': ' + oneLine(again));
    }
  }
  if (!tts.voices || !tts.voices[voice]) {
    throw new Error('Kokoro has no voice ' + JSON.stringify(voice) + '.');
  }
  log('Kokoro is ready (' + voice + ')');
  const loaded = voice || KOKORO_VOICE;
  const engine = {
    appId: MCP_TTS_APP,
    voice: loaded,
    dir,
    hasVoice(name) { return !!(tts.voices && tts.voices[name]); },
    async speak(text, want) {
      const chosen = nativeVoice(want, loaded, (name) => engine.hasVoice(name));
      if (!tts.voices || !tts.voices[chosen]) throw new Error('Kokoro has no voice ' + JSON.stringify(chosen) + '.');
      const audio = await tts.generate(String(text || ''), { voice: chosen });
      const wav = audio.toWav();
      return Buffer.from(wav);
    },
  };
  return engine;
}

function oneLine(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 300);
}
