// GifOS Settings → AI models is where LLM, speech-to-text, and text-to-speech
// live. Meet Bot's setVoice must name those providers and must not carry a
// raw URL or a key. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadConfig } from '../../src/config.js';
import { voiceSettings } from '../../src/voice/settings.js';
import { bridgeScript, expandForHost, fetchPlan, installPlan } from '../../src/voice/providers.js';

const KEY = 'sk-test-key-which-must-stay-here';

test('a fresh profile plan installs Kokoro and the speech-to-text app and does not fetch them', () => {
  const cfg = loadConfig({ GIFOS_MCP_HOME: '/x', GIFOS_STT_APP: 'offline-stt-whisper' });
  const steps = installPlan(cfg);
  assert.deepEqual(steps.map((s) => s.role + ':' + (s.appId || 'endpoint')), ['stt:offline-stt-whisper', 'tts:offline-tts-kokoro']);
  assert.equal(steps.some((s) => s.endpoint), false);
  const named = loadConfig({ GIFOS_MCP_HOME: '/x', GIFOS_TTS_APP: 'tts-synthetic', GIFOS_STT_APP: 'stt-synthetic' });
  assert.equal(installPlan(named).find((s) => s.role === 'tts').appId, 'tts-synthetic');
});

test('an HTTP speech stand-in is a Settings endpoint, not a URL in setVoice', () => {
  const cfg = loadConfig({
    GIFOS_MCP_HOME: '/x',
    GIFOS_TTS_URL: 'http://127.0.0.1:9/voice',
    GIFOS_STT_URL: 'http://127.0.0.1:11/captions',
    GIFOS_LLM_URL: 'http://127.0.0.1:10/v1',
    GIFOS_LLM_MODEL: 'local-model',
    GIFOS_LLM_KEY: KEY,
    GIFOS_STT_APP: 'none',
  });
  const steps = installPlan(cfg);
  assert.equal(steps.find((s) => s.role === 'tts').endpoint.url, 'http://127.0.0.1:9/voice');
  assert.equal(steps.find((s) => s.role === 'stt').endpoint.url, 'http://127.0.0.1:11/captions');
  assert.equal(steps.find((s) => s.role === 'smartest').endpoint.key, KEY);
  assert.equal(steps.some((s) => s.appId === 'offline-tts-kokoro'), false);
  const handed = voiceSettings(cfg.voice);
  assert.equal(handed.llm.provider, 'smartest');
  assert.equal('url' in handed.llm, false);
  assert.equal('key' in handed.llm, false);
  assert.equal(handed.tts.provider, 'tts');
  assert.equal(handed.tts.engine, 'http');
  assert.equal('url' in handed.tts, false);
  assert.equal(handed.stt.provider, 'stt');
  assert.equal(JSON.stringify(handed).includes(KEY), false);
  assert.equal(JSON.stringify(handed).includes('127.0.0.1'), false);
});

test('https pages do not call an http model directly', () => {
  const plan = fetchPlan('http://127.0.0.1:9/v1/chat', 'https://gifos.app/run.html');
  assert.equal(plan.proxy, true);
  assert.equal(plan.url, 'https://cors-proxy.gifos.app/');
  assert.equal(plan.headers['x-gifos-target'], 'http://127.0.0.1:9/v1/chat');
  const same = fetchPlan('https://api.example.test/v1/chat', 'https://gifos.app/run.html');
  assert.equal(same.proxy, false);
  assert.equal(same.url, 'https://api.example.test/v1/chat');
  const local = fetchPlan('http://127.0.0.1:9/v1/chat', 'http://127.0.0.1:19510/run.html');
  assert.equal(local.proxy, false);
});

test('the host bridge reads Settings and does not put the key in the app', () => {
  const ai = {
    smartest: { app: 'file-llm', appId: 'llm-synthetic', appName: 'Synthetic LLM' },
    tts: { app: 'file-tts', appId: 'tts-synthetic', appName: 'Synthetic TTS' },
    stt: { app: 'file-stt', appId: 'stt-synthetic', appName: 'Synthetic STT' },
  };
  const expanded = expandForHost({
    conversation_voice: 'local',
    llm: { provider: 'smartest' },
    tts: { provider: 'tts', engine: 'kokoro', app: 'tts-synthetic', voice: 'af_heart' },
    stt: { provider: 'stt' },
  }, ai);
  assert.equal(expanded.llm.url, 'gifos-provider://smartest');
  assert.equal('key' in expanded.llm, false);
  assert.equal(expanded.tts.engine, 'kokoro');
  assert.equal('url' in (expanded.stt || {}), false);

  const calls = [];
  const sandbox = {
    localStorage: { data: { gifos_ai_config: JSON.stringify(ai) }, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } },
    location: { protocol: 'https:', origin: 'https://gifos.app', href: 'https://gifos.app/run.html' },
    fetch() { throw new Error('the page fetched'); },
  };
  sandbox.window = sandbox;
  sandbox.GifOS = { providers: { call(role, req) { calls.push([role, req]); return Promise.resolve({ text: 'Round trip reply.', bytes: new Uint8Array([1, 2]), mime: 'audio/wav' }); }, assigned() { return true; } } };
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript(), sandbox);
  const seen = [];
  sandbox.HostVoice = {
    create(opts) {
      return {
        opts,
        setVoice(next) { seen.push(next); return { conversation_voice: next.conversation_voice }; },
      };
    },
  };
  const eng = sandbox.HostVoice.create({ fetch: sandbox.fetch, tts() { throw new Error('raw tts'); } });
  const pub = eng.setVoice({ conversation_voice: 'local', llm: { provider: 'smartest' }, tts: { provider: 'tts', engine: 'kokoro', voice: 'af_heart' }, stt: { provider: 'stt' } });
  assert.equal(pub.conversation_voice, 'local');
  assert.equal(seen[0].llm.url, 'gifos-provider://smartest');
  assert.equal(JSON.stringify(seen).includes(KEY), false);
  return eng.opts.fetch('gifos-provider://smartest/extra', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) }).then((res) => {
    assert.equal(res.ok, true);
    assert.equal(calls[0][0], 'smartest');
    assert.equal(calls[0][1].messages[0].content, 'hello');
    return eng.opts.tts({ text: 'Hello from the bot', voice: 'af_heart' });
  }).then((audio) => {
    assert.equal(calls[1][0], 'tts');
    assert.equal(audio.mime, 'audio/wav');
  });
});
