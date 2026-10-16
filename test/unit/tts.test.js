// Engine selection for the open-source voice: Kokoro by default, Piper only
// as a fallback. No browser, no model download, no Piper process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KOKORO_APP, KOKORO_MIN_CPUS, KOKORO_MIN_MEM, DEFAULT_KOKORO_VOICE, DEFAULT_PIPER_VOICE,
  machineCanRunKokoro, piperIsAvailable, resolveTts, activateTts, fallbackAfterKokoroFailure, ttsPublic,
} from '../../src/tts.js';
import { loadConfig } from '../../src/config.js';

const strong = { cpus: KOKORO_MIN_CPUS, totalMem: KOKORO_MIN_MEM };
const weakCpu = { cpus: KOKORO_MIN_CPUS - 1, totalMem: KOKORO_MIN_MEM };
const weakMem = { cpus: KOKORO_MIN_CPUS, totalMem: KOKORO_MIN_MEM - 1 };

test('Kokoro is the default on a machine that can run it', () => {
  const plan = resolveTts({ profile: strong, piperAvailable: true });
  assert.equal(plan.engine, 'kokoro');
  assert.equal(plan.requested, 'auto');
  assert.equal(plan.fallback, false);
  assert.equal(plan.reason, 'default');
  assert.equal(plan.app, KOKORO_APP);
  assert.equal(plan.voice, DEFAULT_KOKORO_VOICE);
  assert.equal(plan.ready, false);
  assert.equal(machineCanRunKokoro(strong), true);
  assert.equal(machineCanRunKokoro(weakCpu), false);
  assert.equal(machineCanRunKokoro(weakMem), false);
});

test('auto selects Piper on a weaker machine', () => {
  for (const profile of [weakCpu, weakMem, null]) {
    const plan = resolveTts({ requested: 'auto', profile, piperAvailable: true });
    assert.equal(plan.engine, 'piper', JSON.stringify(profile));
    assert.equal(plan.fallback, true);
    assert.equal(plan.reason, 'weaker-machine');
    assert.equal(plan.app, '');
    assert.equal(plan.voice, DEFAULT_PIPER_VOICE);
    assert.equal(plan.ready, true);
  }
  const missing = resolveTts({ profile: weakCpu, piperAvailable: false });
  assert.equal(missing.engine, 'piper');
  assert.equal(missing.ready, false);
});

test('GIFOS_TTS_ENGINE forces an engine, and none turns the voice off', () => {
  const piper = resolveTts({ requested: 'piper', profile: strong, piperAvailable: false });
  assert.equal(piper.engine, 'piper');
  assert.equal(piper.fallback, false);
  assert.equal(piper.reason, 'configured');
  assert.equal(piper.ready, false);

  const kokoro = resolveTts({ requested: 'KOKORO', profile: weakCpu, piperAvailable: true });
  assert.equal(kokoro.engine, 'kokoro');
  assert.equal(kokoro.fallback, false);
  assert.equal(kokoro.reason, 'configured');
  assert.equal(kokoro.app, KOKORO_APP);

  const off = resolveTts({ requested: 'none', profile: strong });
  assert.equal(off.engine, 'none');
  assert.equal(off.ready, false);
  assert.equal(off.voice, '');
  assert.throws(() => resolveTts({ requested: 'elevenlabs' }), /GIFOS_TTS_ENGINE/);
});

test('a configured voice replaces the engine default', () => {
  const plan = resolveTts({ profile: strong, voice: 'af_bella' });
  assert.equal(plan.voice, 'af_bella');
  assert.equal(plan.voiceFromUser, true);
  const piper = resolveTts({ requested: 'piper', voice: ' en_US-amy-medium ', piperAvailable: true });
  assert.equal(piper.voice, 'en_US-amy-medium');
});

test('auto falls back to Piper when Kokoro is unavailable', () => {
  const plan = resolveTts({
    requested: 'auto', profile: strong, kokoroAvailable: false, piperAvailable: true,
    piperBin: '/usr/bin/piper', piperModel: '/voices/lessac.onnx',
  });
  assert.equal(plan.engine, 'piper');
  assert.equal(plan.fallback, true);
  assert.equal(plan.reason, 'kokoro-unavailable');
  assert.equal(plan.ready, true);
  assert.equal(plan.piperBin, '/usr/bin/piper');
  assert.equal(plan.piperModel, '/voices/lessac.onnx');
});

test('a Kokoro start failure falls back to Piper when Piper is installed', () => {
  const plan = resolveTts({ requested: 'kokoro', profile: weakCpu, voice: 'af_sarah', piperAvailable: true });
  const next = fallbackAfterKokoroFailure(plan, new Error('The GifOS store has no "offline-tts-kokoro" app'), true);
  assert.equal(next.engine, 'piper');
  assert.equal(next.requested, 'kokoro');
  assert.equal(next.fallback, true);
  assert.equal(next.reason, 'kokoro-failed');
  assert.equal(next.ready, true);
  assert.equal(next.voice, 'af_sarah');
  assert.match(next.error, /offline-tts-kokoro/);
  assert.equal(next.app, '');
});

test('a Kokoro start failure stays on Kokoro when Piper is not installed', () => {
  const plan = resolveTts({ requested: 'auto', profile: strong });
  const next = fallbackAfterKokoroFailure(plan, 'weights missing', false);
  assert.equal(next.engine, 'kokoro');
  assert.equal(next.ready, false);
  assert.equal(next.fallback, false);
  assert.equal(next.reason, 'kokoro-failed');
  assert.equal(next.voice, DEFAULT_KOKORO_VOICE);
  assert.equal(next.error, 'weights missing');
});

test('activateTts installs Kokoro and does not install Piper', async () => {
  const installed = [];
  const plan = resolveTts({ profile: strong });
  const live = await activateTts(plan, {
    piperAvailable: true,
    installKokoro: async (app) => { installed.push(app); return 'file-kokoro'; },
  });
  assert.deepEqual(installed, [KOKORO_APP]);
  assert.equal(live.engine, 'kokoro');
  assert.equal(live.ready, true);
  assert.equal(live.fileId, 'file-kokoro');

  const piper = resolveTts({ requested: 'piper', piperAvailable: true });
  const skipped = await activateTts(piper, {
    installKokoro: async () => { throw new Error('Piper must not install Kokoro'); },
  });
  assert.equal(skipped, piper);

  const off = await activateTts(resolveTts({ requested: 'none' }), {
    installKokoro: async () => { throw new Error('none must not install a voice'); },
  });
  assert.equal(off.engine, 'none');
});

test('activateTts falls back to Piper when the Kokoro install throws', async () => {
  let calls = 0;
  const plan = resolveTts({
    requested: 'auto', profile: strong, piperBin: 'piper', piperModel: '/voices/lessac.onnx',
  });
  const live = await activateTts(plan, {
    piperAvailable: true,
    installKokoro: async () => { calls++; throw new Error('store refused'); },
  });
  assert.equal(calls, 1);
  assert.equal(live.engine, 'piper');
  assert.equal(live.fallback, true);
  assert.equal(live.reason, 'kokoro-failed');
  assert.equal(live.ready, true);
  assert.equal(live.voice, DEFAULT_PIPER_VOICE);
  assert.equal(live.error, 'store refused');

  const stuck = await activateTts(plan, {
    piperAvailable: false,
    installKokoro: async () => { throw new Error('store refused'); },
  });
  assert.equal(stuck.engine, 'kokoro');
  assert.equal(stuck.ready, false);
  assert.equal(stuck.fallback, false);
  assert.equal(stuck.error, 'store refused');
});

test('piper is available only when the voice file and the program exist', () => {
  const files = new Set(['/voices/en.onnx', '/usr/bin/piper']);
  const exists = (p) => files.has(p);
  assert.equal(piperIsAvailable({ bin: 'piper', model: '/voices/en.onnx', exists, pathEnv: '/usr/bin' }), true);
  assert.equal(piperIsAvailable({ bin: 'piper', model: '/voices/en.onnx', exists, pathEnv: '/elsewhere' }), false);
  assert.equal(piperIsAvailable({ bin: '/usr/bin/piper', model: '/voices/en.onnx', exists, pathEnv: '' }), true);
  assert.equal(piperIsAvailable({ bin: '/opt/piper', model: '/voices/en.onnx', exists, pathEnv: '/usr/bin' }), false);
  assert.equal(piperIsAvailable({ bin: 'piper', model: '', exists, pathEnv: '/usr/bin' }), false);
  assert.equal(piperIsAvailable({ bin: 'piper', model: '/voices/missing.onnx', exists, pathEnv: '/usr/bin' }), false);
});

test('loadConfig reads the voice environment', () => {
  const kokoro = loadConfig({ GIFOS_TTS_ENGINE: '  kokoro  ', GIFOS_TTS_VOICE: 'bf_emma' }, { profile: weakCpu });
  assert.equal(kokoro.tts.engine, 'kokoro');
  assert.equal(kokoro.tts.voice, 'bf_emma');
  const piper = loadConfig({
    GIFOS_TTS_ENGINE: 'piper',
    GIFOS_PIPER_BIN: '/usr/bin/piper',
    GIFOS_PIPER_MODEL: '/voices/lessac.onnx',
  }, { profile: strong, piperAvailable: true });
  assert.equal(piper.tts.engine, 'piper');
  assert.equal(piper.tts.fallback, false);
  assert.equal(piper.tts.piperModel, '/voices/lessac.onnx');
  assert.equal(piper.tts.ready, true);
  const small = loadConfig({}, { profile: weakMem, piperAvailable: false });
  assert.equal(small.tts.requested, 'auto');
  assert.equal(small.tts.engine, 'piper');
  assert.equal(small.tts.reason, 'weaker-machine');
  assert.equal(loadConfig({ GIFOS_TTS_ENGINE: 'none' }).tts.engine, 'none');
  assert.throws(() => loadConfig({ GIFOS_TTS_ENGINE: 'cloud' }), /GIFOS_TTS_ENGINE/);
});

test('status prefers the live engine and keeps the requested one', () => {
  const plan = resolveTts({ requested: 'kokoro', profile: strong });
  const live = fallbackAfterKokoroFailure(plan, new Error('install failed'), true);
  const pub = ttsPublic(plan, {
    engine: live.engine, voice: live.voice, fallback: live.fallback,
    reason: live.reason, app: live.app, ready: live.ready,
  });
  assert.equal(pub.engine, 'piper');
  assert.equal(pub.requested, 'kokoro');
  assert.equal(pub.fallback, true);
  assert.equal(pub.reason, 'kokoro-failed');
  assert.equal(pub.app, null);
  assert.equal(pub.ready, true);
  assert.deepEqual(ttsPublic(null, null), null);
});
