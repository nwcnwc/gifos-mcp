// Sidecar endpoints with the fake engine. No model download and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavFromPcm } from '../../src/audio/wav.js';
import { TranscriptLog, readTranscript } from '../../src/participant/transcript.js';

const SIDECAR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'voice', 'sidecar.py');
const TOKEN = 'voice-test-token';

function pcmB64(amp, ms) {
  const n = Math.round(16000 * ms / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin(i * 0.35);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return buf.toString('base64');
}

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-voice-'));
  const child = spawn('python3', [SIDECAR], {
    env: {
      ...process.env,
      GIFOS_VOICE_FAKE: '1',
      GIFOS_VOICE_TOKEN: TOKEN,
      GIFOS_MCP_HOME: home,
      GIFOS_VOICE_FAKE_GAP_MS: '250',
      GIFOS_VAD_END_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error('sidecar did not start ' + err)), 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/GIFOS_VOICE_READY (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('sidecar exited ' + code + ' ' + err)); });
  });
  return {
    home,
    base: 'http://127.0.0.1:' + port,
    stop() {
      if (child.pid && child.pid !== 1 && child.exitCode == null) child.kill('SIGTERM');
    },
  };
}

test('transcript rejects a bad meeting id and appends the live schema', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-tr-'));
  assert.throws(() => new TranscriptLog(home, '../etc'), /bad meeting id/);
  assert.throws(() => readTranscript(home, 'm_abc/../../x'), /bad meeting id/);
  const log = new TranscriptLog(home, 'm_abc');
  const row = log.append({ kind: 'speech', speaker: 'Ada', text: 'hello', ts: 5 });
  assert.deepEqual(row, { seq: 1, ts: 5, speaker: 'Ada', text: 'hello', kind: 'speech' });
  assert.match(readTranscript(home, 'm_abc'), /"kind":"speech"/);
  assert.match(fs.readFileSync(path.join(log.dir, 'transcript.txt'), 'utf8'), /Ada: hello/);
  assert.throws(() => log.append({ kind: 'nope', speaker: 'A', text: 'x', ts: 1 }), /kind/);
});

test('fake sidecar health, sentence streaming, and partial then final', async (t) => {
  const voice = await boot();
  t.after(() => voice.stop());
  const denied = await fetch(voice.base + '/health');
  assert.equal(denied.status, 401);
  const health = await fetch(voice.base + '/health', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.engines.tts, 'fake');
  assert.equal(body.engines.stt, 'fake');
  assert.equal(body.vad.end_ms, 500);
  assert.equal(typeof body.self_test.tts_rtf, 'number');

  const three = 'The purple giraffe reads seven books. The green river is wide. Seven red notebooks sit here.';
  const tts = await fetch(voice.base + '/tts', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ text: three }),
  });
  assert.equal(tts.status, 200);
  assert.equal(tts.headers.get('x-audio-format'), 's16le');
  assert.equal(tts.headers.get('x-sentence-count'), '3');
  const reader = tts.body.getReader();
  const t0 = Date.now();
  let got = Buffer.alloc(0);
  let atFirst = 0;
  let atSecond = 0;
  while (got.length < 14400) {
    const chunk = await reader.read();
    if (chunk.done) break;
    got = Buffer.concat([got, Buffer.from(chunk.value)]);
    if (!atFirst && got.length >= 4800) atFirst = Date.now() - t0;
    if (!atSecond && got.length >= 9600) atSecond = Date.now() - t0;
  }
  assert.ok(got.length >= 14400, 'all three sentences, got ' + got.length);
  assert.ok(atFirst < 200, 'first sentence arrived in ' + atFirst + 'ms');
  assert.ok(atSecond - atFirst > 150, 'second sentence followed the first by ' + (atSecond - atFirst) + 'ms');
  const long = 'Please hold while I describe the quiet library, the green river and the seven red notebooks on the oak table.';
  const split = await fetch(voice.base + '/tts', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ text: long }),
  });
  assert.equal(split.headers.get('x-sentence-count'), '2');
  await split.arrayBuffer();

  const wav = wavFromPcm(new Int16Array(16000), 16000, 1);
  const once = await fetch(voice.base + '/stt', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'audio/wav', 'x-fake-text': 'purple giraffe' },
    body: wav,
  });
  const lines = (await once.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.some((l) => l.final === false), true);
  assert.equal(lines.some((l) => l.final === true && /purple giraffe/.test(l.text)), true);

  const partial = await fetch(voice.base + '/stt', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ stream_id: 'ada', speaker: 'Ada', pcm_b64: pcmB64(0.2, 400), rate: 16000 }),
  });
  const p1 = (await partial.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(p1.some((l) => l.final === false), true);
  const fin = await fetch(voice.base + '/stt', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ stream_id: 'ada', speaker: 'Ada', pcm_b64: pcmB64(0, 600), rate: 16000 }),
  });
  const p2 = (await fin.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(p2.some((l) => l.final === true && l.speaker === 'Ada' && /giraffe/.test(l.text)), true);
});
