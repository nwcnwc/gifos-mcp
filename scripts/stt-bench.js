#!/usr/bin/env node
// Time a speech engine on one wav and print one JSON line.
//
//   GIFOS_MCP_HOME=... node scripts/stt-bench.js --wav sample.wav --ref "expected words"
//   --engine whisper.cpp|transformers   (default whisper.cpp)
//   --model base.en|small.en            (whisper.cpp)
//
// The first pass warms the model. The second pass is the one we report.
// Threads come from GIFOS_STT_THREADS (default 2). No network if the model
// is already under GIFOS_MCP_HOME/models.
import os from 'node:os';
import { wavDurationMs } from '../src/audio/wav.js';
import { wer } from '../src/audio/wer.js';
import { createStt } from '../src/audio/stt.js';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';

try { os.setPriority(15); } catch (e) { /* not allowed; the caller can use nice */ }

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const wavPath = arg('--wav', '');
const ref = arg('--ref', '');
if (!wavPath || !ref) {
  process.stderr.write('usage: stt-bench.js --wav file.wav --ref "expected words" [--engine whisper.cpp] [--model base.en]\n');
  process.exit(2);
}
if (arg('--engine')) process.env.GIFOS_STT_ENGINE = arg('--engine');
if (arg('--model')) process.env.GIFOS_STT_MODEL = arg('--model');
if (!process.env.GIFOS_STT_THREADS) process.env.GIFOS_STT_THREADS = '2';

const wav = fs.readFileSync(wavPath);
const audioS = wavDurationMs(wav) / 1000;
const cfg = loadConfig();
const stt = createStt(cfg);
try {
  const warm = await stt.transcribe(wav);
  const t0 = Date.now();
  const out = await stt.transcribe(wav);
  const elapsedS = (Date.now() - t0) / 1000;
  const line = {
    engine: out.engine || process.env.GIFOS_STT_ENGINE || 'whisper.cpp',
    model: process.env.GIFOS_STT_MODEL || 'base.en',
    arch: process.arch,
    threads: Number(process.env.GIFOS_STT_THREADS),
    audio_s: Math.round(audioS * 100) / 100,
    warm_s: Math.round(warm.ms) / 1000,
    elapsed_s: Math.round(elapsedS * 100) / 100,
    rtf: audioS ? Math.round((elapsedS / audioS) * 100) / 100 : null,
    wer: Math.round(wer(ref, out.text) * 1000) / 1000,
    hypothesis: out.text,
  };
  process.stdout.write(JSON.stringify(line) + '\n');
} finally {
  await stt.close();
}
