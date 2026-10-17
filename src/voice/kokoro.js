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
// A part file left by a process that died (a worker killed when its boot
// ran out of time) is kept: the next match() claims it and asks only for
// the missing bytes, so a slow link gets further on each start instead of
// starting from zero. A bad join still fails the load, which fetches anew.
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
      if (!file) return undefined;
      if (!fs.existsSync(file) && !(await resume(key, file))) return undefined;
      const bytes = await fs.promises.readFile(file);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    },
    async put(key, response, progress) {
      const file = fileFor(key);
      if (!file) return;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const total = parseInt(response.headers.get('content-length') || '0', 10);
      await writePart(file, response, 0, total, progress);
    },
  };
}

// Streams response into <file>.<pid>.part from byte `from` on, then renames
// it into place. A failure removes the part; a kill leaves it for resume().
async function writePart(file, response, from, total, progress) {
  const part = file + '.' + process.pid + '.part';
  const out = fs.createWriteStream(part, from ? { flags: 'a' } : {});
  try {
    const reader = response.body.getReader();
    let loaded = from;
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
}

// Part files of `file` whose process is gone, biggest first.
function deadParts(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return [];
  const name = path.basename(file);
  const found = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(name + '.')) continue;
    const m = /^\.(\d+)\.part$/.exec(entry.slice(name.length));
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    const p = path.join(dir, entry);
    try { found.push({ path: p, size: fs.statSync(p).size }); } catch { /* gone meanwhile */ }
  }
  return found.sort((a, b) => b.size - a.size);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Finishes the biggest dead part of file with a Range request. Several
// workers may start at once: the rename claims a part for one of them, and
// the rest download as usual. Returns true when file is in place.
async function resume(key, file) {
  const parts = deadParts(file);
  const mine = file + '.' + process.pid + '.part';
  let from = -1;
  for (const p of parts) {
    if (from < 0) {
      try { await fs.promises.rename(p.path, mine); from = p.size; continue; } catch { continue; }
    }
    await fs.promises.rm(p.path, { force: true });
  }
  if (from < 0) return false;
  try {
    const res = from > 0 ? await fetch(key, { headers: { Range: 'bytes=' + from + '-' } }) : null;
    const range = res && res.status === 206 && /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get('content-range') || '');
    if (range && Number(range[1]) === from) {
      log('Kokoro: resuming ' + path.basename(file) + ' at ' + from + ' of ' + range[2] + ' bytes');
      await writePart(file, res, from, Number(range[2]));
      return true;
    }
    if (res && res.status === 200) {
      // No Range support: this answer is the whole file.
      await writePart(file, res, 0, parseInt(res.headers.get('content-length') || '0', 10));
      return true;
    }
    if (res && res.body) await res.body.cancel().catch(() => {});
  } catch (e) {
    log('Kokoro: could not resume ' + path.basename(file) + ' (' + oneLine(e) + '); downloading it again');
  }
  await fs.promises.rm(mine, { force: true });
  return false;
}

// Part files left by a process that was killed while downloading: the
// biggest of each file is kept for resume(), the rest are dropped, and so
// is any part of a file that is already whole.
function dropDeadParts(dir) {
  if (!fs.existsSync(dir)) return;
  const kept = new Set();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const m = /^(.+)\.(\d+)\.part$/.exec(String(rel));
    if (!m) continue;
    const file = path.join(dir, m[1]);
    if (kept.has(file)) continue;
    kept.add(file);
    const parts = deadParts(file);
    const keep = fs.existsSync(file) ? 0 : 1;
    for (const p of parts.slice(keep)) fs.rmSync(p.path, { force: true });
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
