// Which speech engine to use. No network and no filesystem: callers pass
// what they already know. The running engines live in stt.js and tts.js.

export const DEFAULT_STT_ENGINE = 'whisper.cpp';
export const DEFAULT_TTS_ENGINE = 'piper';
export const DEFAULT_STT_MODEL = 'base.en';

export function isOpenAiTranscriptions(url) {
  try { return /\/v1\/audio\/transcriptions\/?$/.test(new URL(url).pathname); }
  catch (e) { return /audio\/transcriptions/.test(String(url || '')); }
}

export function isOpenAiSpeech(url) {
  try { return /\/v1\/audio\/speech\/?$/.test(new URL(url).pathname); }
  catch (e) { return /audio\/speech/.test(String(url || '')); }
}

export function selectStt(env = {}) {
  const url = String(env.GIFOS_STT_URL || '').trim();
  if (url) return { id: 'http', url, openai: isOpenAiTranscriptions(url) };
  const want = String(env.GIFOS_STT_ENGINE || '').trim().toLowerCase();
  if (!want || want === 'whisper.cpp' || want === 'whisper' || want === 'whisper-cpp') {
    return { id: 'whisper.cpp', model: String(env.GIFOS_STT_MODEL || DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL };
  }
  if (want === 'transformers' || want === 'onnx') {
    return { id: 'transformers', model: String(env.GIFOS_STT_MODEL || 'onnx-community/whisper-base.en').trim() };
  }
  throw new Error('Unknown GIFOS_STT_ENGINE ' + JSON.stringify(want) + '. Use whisper.cpp, transformers, or set GIFOS_STT_URL.');
}

export function selectTts(env = {}) {
  const url = String(env.GIFOS_TTS_URL || '').trim();
  if (url) return { id: 'http', url, openai: isOpenAiSpeech(url) };
  const want = String(env.GIFOS_TTS_ENGINE || '').trim().toLowerCase();
  if (!want || want === 'piper') return { id: 'piper' };
  if (want === 'kokoro') return { id: 'kokoro' };
  if (want === 'espeak' || want === 'espeak-ng') return { id: 'espeak' };
  throw new Error('Unknown GIFOS_TTS_ENGINE ' + JSON.stringify(want) + '. Use piper, kokoro, espeak, or set GIFOS_TTS_URL.');
}

export function sttThreads(env = {}) {
  const n = Number(env.GIFOS_STT_THREADS);
  if (Number.isFinite(n) && n >= 1) return Math.min(8, Math.round(n));
  return 2;
}
