// Install downloads Kokoro once, then the tts role speaks with it.
// The host bridge is the stand-in provider: a GIF cannot fetch this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installKokoro } from '../../src/voice/kokoro.js';
import { MCP_TTS_APP } from '../../src/voice/settings.js';
import { bridgeScript, MCP_TTS_BINDING, speakAsTts } from '../../src/voice/providers.js';

const HOME = path.join(os.tmpdir(), 'gifos-mcp-kokoro-weights');
const LINE = 'Hello.';

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

test('install leads to Kokoro speaking through the tts role', async () => {
  const engine = await installKokoro({ home: HOME, voice: 'af_heart' });
  assert.equal(engine.appId, MCP_TTS_APP);
  assert.equal(engine.voice, 'af_heart');
  const spoken = await speakAsTts(engine, { text: LINE, voice: 'af_heart' });
  assert.equal(spoken.role, 'tts');
  assert.equal(spoken.appId, MCP_TTS_APP);
  assert.equal(spoken.mime, 'audio/wav');
  assert.equal(spoken.voice, 'af_heart');
  const info = wavInfo(spoken.bytes);
  assert.equal(info.rate, 24000);
  assert.equal(info.channels, 1);
  assert.ok(info.samples > 24000 * 0.2, 'the line is longer than a fifth of a second');
  assert.ok(info.mean > 100, 'the waveform is not silence');

  const calls = [];
  let handed = null;
  const sandbox = {
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    localStorage: { getItem() { return '{}'; } },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/run.html' },
    fetch() { throw new Error('the page fetched'); },
    setTimeout() { throw new Error('the provider was not registered during install'); },
  };
  sandbox.window = sandbox;
  sandbox[MCP_TTS_BINDING] = (text, voice) => speakAsTts(engine, { text, voice }).then((out) => {
    calls.push([text, voice]);
    handed = Buffer.from(out.bytes);
    return handed.toString('base64');
  });
  sandbox.GifOS = {
    providers: {
      call(role) { return Promise.reject(new Error('store provider was called for ' + role)); },
      assigned() { return null; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript({ mcpTts: true }), sandbox);
  const assigned = sandbox.GifOS.providers.assigned('tts');
  assert.equal(assigned.appId, MCP_TTS_APP);
  const audio = await sandbox.GifOS.providers.call('tts', { text: LINE, voice: 'af_heart' });
  assert.equal(audio.mime, 'audio/wav');
  assert.deepEqual(calls, [[LINE, 'af_heart']]);
  assert.ok(Buffer.from(audio.bytes).equals(handed), 'the tts role returns the WAV Kokoro just produced');
  const through = wavInfo(audio.bytes);
  assert.equal(through.rate, 24000);
  assert.ok(through.mean > 100, 'the role spoke');
  const chat = await sandbox.GifOS.providers.call('smartest', { op: 'chat' }).then(() => null, (e) => e);
  assert.match(chat.message, /store provider was called for smartest/);
});
