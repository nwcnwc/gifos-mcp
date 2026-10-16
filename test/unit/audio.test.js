// VAD, turn hint, engine choice, names, and wav. No network and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVad, isHallucination, turnHint } from '../../src/audio/vad.js';
import { selectStt, selectTts, sttThreads } from '../../src/audio/engines.js';
import { keywordHits, wer } from '../../src/audio/wer.js';
import { parseWav, toMono16k, wavDurationMs, wavFromPcm } from '../../src/audio/wav.js';
import { isSelfName, withAiBadge } from '../../src/participant/names.js';

function frame(amp, ms) {
  const n = Math.round(16000 * ms / 1000);
  const f32 = new Float32Array(n);
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin(i * 0.4);
    f32[i] = s;
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return { f32, i16 };
}

test('a loud stretch followed by silence becomes one utterance', () => {
  const vad = createVad();
  let heard = null;
  let t = 0;
  for (let i = 0; i < 4; i++) {
    t += 100;
    const f = frame(0.2, 100);
    const r = vad.feed(f.f32, f.i16, t);
    assert.equal(r.utterance, null);
  }
  for (let i = 0; i < 5; i++) {
    t += 100;
    const f = frame(0, 100);
    const r = vad.feed(f.f32, f.i16, t);
    if (r.utterance) heard = r.utterance;
  }
  assert.ok(heard, 'silence closed the utterance');
  assert.ok(heard.speechMs >= 300);
  assert.ok(heard.pcm.length > 1000);
  assert.ok(heard.tEnd > heard.tStart);
});

test('a short click is not an utterance', () => {
  const vad = createVad();
  const f = frame(0.2, 100);
  vad.feed(f.f32, f.i16, 100);
  let heard = false;
  let t = 100;
  for (let i = 0; i < 6; i++) {
    t += 100;
    const s = frame(0, 100);
    if (vad.feed(s.f32, s.i16, t).utterance) heard = true;
  }
  assert.equal(heard, false);
});

test('turn_hint waits for speech, for a transcript, and for the pause', () => {
  assert.equal(turnHint({ speakingNow: ['Ada'], silenceMs: 5000 }), 'wait');
  assert.equal(turnHint({ speakingNow: [], selfSpeaking: true, silenceMs: 5000 }), 'wait');
  assert.equal(turnHint({ speakingNow: [], pending: true, silenceMs: 5000 }), 'wait');
  assert.equal(turnHint({ speakingNow: [], silenceMs: 699 }), 'wait');
  assert.equal(turnHint({ speakingNow: [], silenceMs: 700 }), 'your_turn');
  assert.equal(turnHint({ speakingNow: [], silenceMs: 100, pauseMs: 100 }), 'your_turn');
});

test('whisper silence lines are dropped and real words are kept', () => {
  assert.equal(isHallucination('Thank you.'), true);
  assert.equal(isHallucination('you'), true);
  assert.equal(isHallucination('Thanks for watching!'), true);
  assert.equal(isHallucination(''), true);
  assert.equal(isHallucination('the purple giraffe reads seven books'), false);
});

test('engine selection prefers a URL and rejects unknown names', () => {
  assert.equal(selectStt({}).id, 'whisper.cpp');
  assert.equal(selectStt({ GIFOS_STT_MODEL: 'small.en' }).model, 'small.en');
  assert.deepEqual(selectStt({ GIFOS_STT_URL: 'http://127.0.0.1:9/v1/audio/transcriptions' }), {
    id: 'http', url: 'http://127.0.0.1:9/v1/audio/transcriptions', openai: true,
  });
  assert.equal(selectStt({ GIFOS_STT_URL: 'http://127.0.0.1:9/stt' }).openai, false);
  assert.equal(selectStt({ GIFOS_STT_ENGINE: 'transformers' }).id, 'transformers');
  assert.throws(() => selectStt({ GIFOS_STT_ENGINE: 'cloud' }), /GIFOS_STT_ENGINE/);
  assert.equal(selectTts({}).id, 'piper');
  assert.equal(selectTts({ GIFOS_TTS_ENGINE: 'espeak' }).id, 'espeak');
  assert.equal(selectTts({ GIFOS_TTS_URL: 'http://127.0.0.1:9/v1/audio/speech' }).openai, true);
  assert.throws(() => selectTts({ GIFOS_TTS_ENGINE: 'cloud' }), /GIFOS_TTS_ENGINE/);
  assert.equal(sttThreads({}), 2);
  assert.equal(sttThreads({ GIFOS_STT_THREADS: '1' }), 1);
  assert.equal(sttThreads({ GIFOS_STT_THREADS: '99' }), 8);
});

test('wav round trip keeps the duration', () => {
  const pcm = new Int16Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 100) - 50;
  const wav = wavFromPcm(pcm, 16000, 1);
  assert.equal(wavDurationMs(wav), 1000);
  const back = parseWav(wav);
  assert.equal(back.rate, 16000);
  assert.equal(back.pcm.length, 32000);
  const stereo = new Int16Array(8000);
  for (let i = 0; i < stereo.length; i++) stereo[i] = i % 2 === 0 ? 1000 : -1000;
  const wide = wavFromPcm(stereo, 8000, 2);
  const mono = parseWav(toMono16k(wide));
  assert.equal(mono.rate, 16000);
  assert.equal(mono.channels, 1);
});

test('word error rate and keyword hits ignore case', () => {
  assert.equal(wer('ask not what your country can do for you', 'ask not what your country can do for you'), 0);
  assert.ok(wer('the purple giraffe reads seven books', 'the purple giraffe read seven books') < 0.2);
  const hits = keywordHits('The Purple Giraffe Read Seven Books.', ['purple', 'giraffe', 'seven', 'books', 'missing']);
  assert.deepEqual(hits, ['purple', 'giraffe', 'seven', 'books']);
});

test('the robot badge survives the 40 character tile limit', () => {
  assert.equal(withAiBadge('Ada'), 'Ada 🤖');
  assert.equal(withAiBadge('Ada 🤖'), 'Ada 🤖');
  assert.equal(withAiBadge(''), 'Assistant 🤖');
  const long = withAiBadge('x'.repeat(80));
  assert.ok(long.length <= 40, long.length);
  assert.ok(long.endsWith('🤖'));
  assert.equal(isSelfName('Ada 🤖', 'Ada 🤖'), true);
  assert.equal(isSelfName('Ada', 'Ada 🤖'), false);
});
