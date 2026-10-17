// Whisper invents stock phrases on a quiet tail. "so long friends." showed
// up after silence. The same words spoken out loud are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { heardText } from '../../src/voice/hallucination.js';
import { serveHost } from '../../src/voice/host.js';
import { LiveTranscript } from '../../src/voice/live.js';
import { bridgeScript } from '../../src/voice/providers.js';

function wavOf(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
  const buf = Buffer.alloc(44 + data.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

const silent = wavOf(new Array(1600).fill(0));
const loud = wavOf(Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i / 8) * 8000)));

test('known whisper phrases on low-energy audio are dropped', () => {
  assert.equal(heardText('so long friends.', silent), '');
  assert.equal(heardText('So long, friends.', silent), '');
  assert.equal(heardText('Thanks for watching.', silent), '');
  assert.equal(heardText('thank you', silent), '');
  assert.equal(heardText('so long friends.', loud), 'so long friends.');
  assert.equal(heardText('thank you', loud), 'thank you');
  assert.equal(heardText('Ship the notes.', silent), 'Ship the notes.');
  assert.equal(heardText('so long friends.', null), 'so long friends.');
});

test('hosted captions drop a silent-tail hallucination', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ text: 'so long friends.' }),
  });
  const quiet = await serveHost(
    { stt: { url: 'http://127.0.0.1:9/captions' } },
    'stt',
    { audio: silent, mime: 'audio/wav' },
    fetchImpl,
  );
  assert.equal(quiet.text, '');
  const said = await serveHost(
    { stt: { url: 'http://127.0.0.1:9/captions' } },
    'stt',
    { audio: loud, mime: 'audio/wav' },
    fetchImpl,
  );
  assert.equal(said.text, 'so long friends.');
});

test('a caption that is only a silent-tail phrase is not stored', () => {
  const live = new LiveTranscript('');
  const id = 'm_abcde12345';
  live.ingestCaption(id, 'Ada: so long friends.\nBob: Ship the notes.\nAda: thank you', 'notes-test');
  assert.deepEqual(live.tail(id, 0).lines.map((l) => l.speaker + ': ' + l.text), [
    'Bob: Ship the notes.',
    'Ada: thank you',
  ]);
});

test('the page drops a store caption when the clip is a silent tail', async () => {
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/index.html' },
    setTimeout() { throw new Error('providers were not registered at launch'); },
    GifOS: {
      providers: {
        call(role, req) {
          assert.equal(role, 'stt');
          return Promise.resolve({ text: req && req.reply, language: 'en' });
        },
        assigned() { return null; },
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript({ hostRoles: ['tts'] }), sandbox);
  const dropped = await sandbox.GifOS.providers.call('stt', { bytes: Uint8Array.from(silent), reply: 'so long friends.' });
  assert.equal(dropped.text, '');
  const kept = await sandbox.GifOS.providers.call('stt', { bytes: Uint8Array.from(loud), reply: 'so long friends.' });
  assert.equal(kept.text, 'so long friends.');
  const real = await sandbox.GifOS.providers.call('stt', { bytes: Uint8Array.from(silent), reply: 'Ship the notes.' });
  assert.equal(real.text, 'Ship the notes.');
});
