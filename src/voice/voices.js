// OpenAI-shaped callers (the GifOS broker, a Piper stand-in) name voices
// this process does not load. alloy is the broker default. Kokoro here is
// af_heart unless GIFOS_TTS_VOICE says otherwise. A name the engine has is
// kept. Anything else, including the OpenAI set, uses the configured voice.

const OPENAI_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

export function nativeVoice(asked, fallback, hasVoice) {
  const want = String(asked || '').trim();
  const def = String(fallback || '').trim();
  if (!want) return def;
  if (typeof hasVoice === 'function' && hasVoice(want)) return want;
  if (OPENAI_VOICES.has(want.toLowerCase())) return def;
  if (typeof hasVoice === 'function') return def;
  return want;
}
