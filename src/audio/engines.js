// Which speech engine to use. No network and no filesystem: callers pass
// what they already know. The running engines live in stt.js and tts.js.

export const DEFAULT_STT_ENGINE = 'faster-whisper';
export const DEFAULT_TTS_ENGINE = 'kokoro';
export const DEFAULT_STT_MODEL = 'base.en';

export function isOpenAiTranscriptions(url) {
  try { return /\/v1\/audio\/transcriptions\/?$/.test(new URL(url).pathname); }
  catch (e) { return /audio\/transcriptions/.test(String(url || '')); }
}

export function isOpenAiSpeech(url) {
  try { return /\/v1\/audio\/speech\/?$/.test(new URL(url).pathname); }
  catch (e) { return /audio\/speech/.test(String(url || '')); }
}

function named(env, primary, alias) {
  return String(env[primary] || env[alias] || '').trim().toLowerCase();
}

export function selectStt(env = {}) {
  const url = String(env.GIFOS_STT_URL || '').trim();
  if (url) return { id: 'http', url, openai: isOpenAiTranscriptions(url) };
  const want = named(env, 'GIFOS_STT', 'GIFOS_STT_ENGINE');
  const model = String(env.GIFOS_STT_MODEL || DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;
  if (/distil/.test(want) || /distil/.test(model)) {
    throw new Error('distil-small.en is not used. Set GIFOS_STT_MODEL to tiny.en, base.en, or small.en.');
  }
  if (!want || want === 'faster-whisper' || want === 'faster_whisper' || want === 'fasterwhisper') {
    return { id: 'faster-whisper', model };
  }
  if (want === 'whisper.cpp' || want === 'whisper' || want === 'whisper-cpp') {
    return { id: 'whisper.cpp', model };
  }
  if (want === 'transformers' || want === 'onnx') {
    return { id: 'transformers', model: String(env.GIFOS_STT_MODEL || 'onnx-community/whisper-base.en').trim() };
  }
  throw new Error('Unknown GIFOS_STT ' + JSON.stringify(want) + '. Use faster-whisper, whisper.cpp, transformers, or set GIFOS_STT_URL.');
}

export function selectTts(env = {}) {
  const url = String(env.GIFOS_TTS_URL || '').trim();
  if (url) return { id: 'http', url, openai: isOpenAiSpeech(url) };
  const want = named(env, 'GIFOS_TTS', 'GIFOS_TTS_ENGINE');
  if (!want || want === 'kokoro' || want === 'kokoro-onnx') return { id: 'kokoro' };
  if (want === 'kokoro-js') return { id: 'kokoro-js' };
  if (want === 'piper') return { id: 'piper' };
  if (want === 'espeak' || want === 'espeak-ng') return { id: 'espeak' };
  throw new Error('Unknown GIFOS_TTS ' + JSON.stringify(want) + '. Use kokoro, piper, espeak, or set GIFOS_TTS_URL.');
}

export function sttThreads(env = {}) {
  const n = Number(env.GIFOS_STT_THREADS);
  if (Number.isFinite(n) && n >= 1) return Math.min(8, Math.round(n));
  return 4;
}
