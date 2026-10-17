// The Meet Bot asks gifos.ai.tts({ text }) with no voice. The GifOS broker
// fills the OpenAI default, alloy. Kokoro on this computer was loaded with
// af_heart, so speak used to throw and the reply never reached the room or
// the transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { speakAsTts, bridgeScript, HOST_BINDING } from '../../src/voice/providers.js';
import { serveHost, packHostResult } from '../../src/voice/host.js';
import { LiveTranscript } from '../../src/voice/live.js';
import { KOKORO_VOICE } from '../../src/voice/settings.js';

const LINE = 'Ship the notes.';
const MEETING = 'm_abcde12345';

function wav() {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  return buf;
}

// The same check installKokoro's speak() makes: a name that is not loaded throws.
function kokoroLoadedWith(voice) {
  const voices = { [voice]: true };
  return {
    appId: 'mcp-tts-kokoro',
    voice,
    voices,
    hasVoice(name) { return !!voices[name]; },
    async speak(text, want) {
      const chosen = String(want || voice);
      if (!voices[chosen]) throw new Error('Kokoro has no voice ' + JSON.stringify(chosen) + '.');
      return wav();
    },
  };
}

function brokerAI(sandbox, op, payload) {
  const cfg = JSON.parse(sandbox.localStorage.getItem('gifos_ai_config') || '{}');
  const role = op === 'chat' ? 'smartest' : op;
  const c = cfg[role];
  if (!c || (!c.url && !c.app)) throw new Error('NOT_CONFIGURED:ai:' + role);
  const path = op === 'tts' ? '/audio/' + 'speech' : '/chat/' + 'completions';
  const base = String(c.url).replace(/\/+$/, '');
  const url = base.slice(-path.length) === path ? base : base + path;
  const body = op === 'tts'
    ? { model: c.model || 'tts-1', input: String(payload.text || ''), voice: payload.voice || c.voice || 'alloy' }
    : { model: c.model || 'gpt-4o-mini', messages: payload.messages || [] };
  return sandbox.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('an OpenAI voice name such as alloy is spoken with the Kokoro default and lands on the transcript', async () => {
  const engine = kokoroLoadedWith(KOKORO_VOICE);
  const live = new LiveTranscript('');
  const stored = {};
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; },
      setItem(k, v) { stored[k] = String(v); },
    },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/index.html' },
    fetch() { throw new Error('the page fetched'); },
    setTimeout() { throw new Error('providers were not registered at launch'); },
    GifOS: { providers: { call() { return Promise.reject(new Error('store provider')); }, assigned() { return null; } } },
  };
  sandbox.window = sandbox;
  sandbox[HOST_BINDING] = async (role, payload) => {
    const req = JSON.parse(payload);
    assert.equal(role, 'tts');
    assert.equal(req.voice, 'alloy');
    assert.equal(req.text, LINE);
    const spoken = await speakAsTts(engine, req);
    assert.equal(spoken.bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(spoken.bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(spoken.voice, KOKORO_VOICE);
    live.ingestCaption(MEETING, 'notes-test: ' + LINE, 'notes-test');
    return packHostResult(spoken);
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript({ hostRoles: ['tts', 'smartest'] }), sandbox);

  const audio = await brokerAI(sandbox, 'tts', { text: LINE });
  assert.equal(audio.ok, true);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');

  const lines = live.tail(MEETING, 0).lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'spoken');
  assert.equal(lines[0].speaker, 'notes-test');
  assert.equal(lines[0].text, LINE);
  assert.deepEqual(lines.filter((l) => l.kind === 'speech'), []);
});

test('a Kokoro voice the engine actually has is left alone', async () => {
  const engine = kokoroLoadedWith(KOKORO_VOICE);
  engine.voices.af_bella = true;
  const spoken = await speakAsTts(engine, { text: LINE, voice: 'af_bella' });
  assert.equal(spoken.voice, 'af_bella');
  assert.equal(spoken.bytes.toString('ascii', 0, 4), 'RIFF');
});

test('a Piper stand-in maps an OpenAI voice name to its configured voice', async () => {
  let posted = null;
  const fetchImpl = async (url, init) => {
    posted = JSON.parse(init.body);
    return { ok: true, status: 200, arrayBuffer: async () => wav() };
  };
  const out = await serveHost(
    { tts: { url: 'http://127.0.0.1:9/speak', voice: 'en_US-lessac-medium' } },
    'tts',
    { text: LINE, voice: 'alloy' },
    fetchImpl,
  );
  assert.equal(posted.text, LINE);
  assert.equal(posted.voice, 'en_US-lessac-medium');
  assert.equal(out.voice, 'en_US-lessac-medium');
  assert.equal(out.bytes.toString('ascii', 0, 4), 'RIFF');
  await serveHost(
    { tts: { url: 'http://127.0.0.1:9/speak', voice: 'en_US-lessac-medium' } },
    'tts',
    { text: LINE, voice: 'no-such-voice' },
    fetchImpl,
  );
  assert.equal(posted.voice, 'en_US-lessac-medium');
});
