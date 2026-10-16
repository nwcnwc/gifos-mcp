// Kokoro runs in this process, on the machine that runs gifos-mcp.
// The first call downloads the weights and the af_heart voice into
// GIFOS_MCP_HOME/kokoro. Nothing here is a provider GIF, and nothing
// listens on the network. The headless harness turns speak() into the
// bytes for the tts role. See docs/MEETBOT-BRIDGE.md.
import fs from 'node:fs';
import path from 'node:path';
import { MCP_TTS_APP, KOKORO_VOICE } from './settings.js';
import { log } from '../log.js';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_DTYPE = 'q8';

const loads = new Map();

export function installKokoro({ home, voice } = {}) {
  if (!home) throw new Error('Kokoro needs a directory to keep its weights.');
  const dir = path.join(home, 'kokoro');
  let pending = loads.get(dir);
  if (!pending) {
    pending = load(dir, voice || KOKORO_VOICE).catch((e) => {
      loads.delete(dir);
      throw e;
    });
    loads.set(dir, pending);
  }
  return pending;
}

async function load(dir, voice) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = dir;
  const { KokoroTTS } = await import('kokoro-js');
  log('Kokoro: loading ' + KOKORO_MODEL + ' (' + KOKORO_DTYPE + ') into ' + dir);
  const seen = new Set();
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
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
  if (!tts.voices || !tts.voices[voice]) {
    throw new Error('Kokoro has no voice ' + JSON.stringify(voice) + '.');
  }
  log('Kokoro is ready (' + voice + ')');
  return {
    appId: MCP_TTS_APP,
    voice,
    dir,
    async speak(text, want) {
      const chosen = String(want || voice || KOKORO_VOICE);
      if (!tts.voices[chosen]) throw new Error('Kokoro has no voice ' + JSON.stringify(chosen) + '.');
      const audio = await tts.generate(String(text || ''), { voice: chosen });
      const wav = audio.toWav();
      return Buffer.from(wav);
    },
  };
}
