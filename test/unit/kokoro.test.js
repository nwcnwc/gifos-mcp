// Install downloads Kokoro once. The host binding then answers tts with
// that audio, and the same binding answers smartest and stt. The page
// does not fetch, and it does not see the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installKokoro } from '../../src/voice/kokoro.js';
import { MCP_TTS_APP } from '../../src/voice/settings.js';
import { bridgeScript, HOST_BINDING, speakAsTts } from '../../src/voice/providers.js';
import { packHostResult, serveHost } from '../../src/voice/host.js';

const HOME = path.join(os.tmpdir(), 'gifos-mcp-kokoro-weights');
const LINE = 'Hello.';
const KEY = 'sk-test-key-which-must-stay-here';

function wavInfo(buf) {
  const b = Buffer.from(buf);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  const rate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const data = b.readUInt32LE(40);
  let energy = 0;
  const n = Math.min(data, b.length - 44) / 2;
  for (let i = 0; i < n; i++) energy += Math.abs(b.readInt16LE(44 + i * 2));
  return { rate, channels, samples: n, mean: n ? energy / n : 0 };
}

test('install leads to Kokoro, captions, and the model through the host binding', async () => {
  const engine = await installKokoro({ home: HOME, voice: 'af_heart' });
  assert.equal(engine.appId, MCP_TTS_APP);
  assert.equal(engine.voice, 'af_heart');
  const spoken = await speakAsTts(engine, { text: LINE, voice: 'af_heart' });
  assert.equal(spoken.role, 'tts');
  assert.equal(spoken.mime, 'audio/wav');
  const info = wavInfo(spoken.bytes);
  assert.equal(info.rate, 24000);
  assert.equal(info.channels, 1);
  assert.ok(info.samples > 24000 * 0.2, 'the line is longer than a fifth of a second');
  assert.ok(info.mean > 100, 'the waveform is not silence');

  const fetches = [];
  let handed = null;
  const services = {
    kokoro: engine,
    llm: { url: 'https://api.example.test/v1', key: KEY, model: 'local-model' },
    stt: { url: 'https://stt.example.test/captions' },
  };
  function mockFetch(url, init) {
    fetches.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: 'Round trip reply.' } }] }),
      });
    }
    if (u.includes('captions')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ text: 'heard the line' }),
      });
    }
    return Promise.reject(new Error('unexpected host fetch ' + u));
  }

  let pageFetched = false;
  const stored = {
    gifos_ai_config: JSON.stringify({
      smartest: { url: 'https://api.example.test/v1', key: KEY, model: 'local-model' },
      tts: { url: 'http://127.0.0.1:9/voice' },
      stt: { url: 'https://stt.example.test/captions' },
    }),
  };
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    localStorage: {
      getItem(k) { return stored[k] || null; },
      setItem(k, v) { stored[k] = String(v); },
    },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/run.html' },
    fetch() { pageFetched = true; throw new Error('the page fetched'); },
    setTimeout() { throw new Error('the provider was not registered during install'); },
  };
  sandbox.window = sandbox;
  sandbox[HOST_BINDING] = (role, payload) => serveHost(services, role, JSON.parse(payload), mockFetch).then((out) => {
    if (out.bytes) handed = Buffer.from(out.bytes);
    const packed = packHostResult(out);
    assert.equal(packed.includes(KEY), false);
    return packed;
  });
  sandbox.GifOS = {
    providers: {
      call(role) { return Promise.reject(new Error('store provider was called for ' + role)); },
      assigned() { return null; },
    },
  };
  vm.createContext(sandbox);
  const script = bridgeScript({ hostRoles: ['tts', 'smartest', 'stt'] });
  assert.equal(script.includes('__gifosMcpSpeak'), false);
  assert.equal(script.includes(KEY), false);
  vm.runInContext(script, sandbox);

  assert.equal(stored.gifos_ai_config.includes(KEY), false, 'a hosted role is removed from the page settings');
  const assigned = sandbox.GifOS.providers.assigned('tts');
  assert.equal(assigned.host, true);
  assert.equal(assigned.name, 'gifos-mcp');
  assert.equal(assigned.appId, undefined);
  assert.equal(assigned.fileId, undefined);
  assert.equal(sandbox.GifOS.providers.assigned('smartest').host, true);
  assert.equal(sandbox.GifOS.providers.assigned('stt').host, true);

  const audio = await sandbox.GifOS.providers.call('tts', { text: LINE, voice: 'af_heart' });
  assert.equal(audio.mime, 'audio/wav');
  assert.ok(Buffer.from(audio.bytes).equals(handed), 'the tts role returns the WAV this call produced');
  const through = wavInfo(audio.bytes);
  assert.equal(through.rate, 24000);
  assert.ok(through.mean > 100, 'the role spoke');
  assert.equal(pageFetched, false);

  const clip = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const heard = await sandbox.GifOS.providers.call('stt', { audio: clip, mime: 'audio/wav' });
  assert.equal(heard.text, 'heard the line');
  assert.equal(Buffer.from(fetches.find((f) => f.url.includes('captions')).init.body).toString('binary'), Buffer.from(clip).toString('binary'));

  const seen = [];
  sandbox.HostVoice = {
    create(opts) {
      return {
        opts,
        setVoice(next) { seen.push(next); return next; },
      };
    },
  };
  const eng = sandbox.HostVoice.create({ fetch: sandbox.fetch });
  eng.setVoice({
    llm: { provider: 'smartest', url: 'https://api.example.test/v1', key: KEY, model: 'local-model' },
    tts: { provider: 'tts', engine: 'http', url: 'http://127.0.0.1:9/voice', voice: 'af_heart' },
    stt: { provider: 'stt', url: 'https://stt.example.test/captions' },
  });
  assert.equal(seen[0].llm.url, 'gifos-provider://smartest');
  assert.equal('key' in seen[0].llm, false);
  assert.equal(seen[0].tts.engine, 'kokoro');
  assert.equal('url' in seen[0].tts, false);
  assert.equal(JSON.stringify(seen).includes(KEY), false);
  const res = await eng.opts.fetch('gifos-provider://smartest', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.ok, true);
  const body = await res.text();
  assert.match(body, /Round trip reply/);
  assert.equal(body.includes(KEY), false);
  const chatFetch = fetches.find((f) => f.url.endsWith('/chat/completions'));
  assert.equal(chatFetch.init.headers.authorization, 'Bearer ' + KEY);
  assert.equal(pageFetched, false);

  const other = await sandbox.GifOS.providers.call('cheapest', { op: 'chat' }).then(() => null, (e) => e);
  assert.match(other.message, /store provider was called for cheapest/);
});
