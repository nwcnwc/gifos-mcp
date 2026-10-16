// Energy VAD and the turn hint. Pure: feed PCM, get utterances. The same
// thresholds ride in the meeting page for barge-in (see participant/page.js).
// Adapted from the meet.js voice bot's ear (test/swarm/voicebot/page.js).

export const TARGET_RATE = 16000;

export const VAD_DEFAULTS = {
  vadEndMs: 450,
  minSpeechMs: 300,
  onsetMs: 80,
  preRollMs: 240,
  maxUtterMs: 20000,
  noise: 0.004,
  noiseMin: 0.0015,
  keepTailSec: 0.15,
};

export function rms(f32) {
  let s = 0;
  const n = f32.length || 1;
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  return Math.sqrt(s / n);
}

function samplesToMs(n) { return n / TARGET_RATE * 1000; }

export function createVad(opts = {}) {
  const d = { ...VAD_DEFAULTS, ...opts };
  let noise = d.noise;
  let pre = [];
  let preSamples = 0;
  let speechMs = 0;
  let silenceMs = 0;
  let utter = [];
  let utterMs = 0;
  let active = false;
  let utterStart = 0;

  function reset() {
    pre = []; preSamples = 0; speechMs = 0; silenceMs = 0;
    utter = []; utterMs = 0; active = false;
  }

  // f32 and i16 are the same frame (16 kHz mono). nowMs is the caller's clock
  // at the END of the frame. Returns { utterance|null, speaking, energy, hot }.
  function feed(f32, i16, nowMs) {
    const ms = samplesToMs(f32.length);
    const energy = rms(f32);
    if (energy < noise * 1.6) noise = noise * 0.9 + energy * 0.1;
    if (noise < d.noiseMin) noise = d.noiseMin;
    const hot = energy > Math.max(noise * 3.2, 0.006);
    if (!active) {
      pre.push(i16);
      preSamples += i16.length;
      while (samplesToMs(preSamples) > d.preRollMs && pre.length > 1) {
        preSamples -= pre.shift().length;
      }
      if (hot) {
        speechMs += ms;
        if (speechMs >= d.onsetMs) {
          active = true;
          utter = pre.splice(0, pre.length);
          preSamples = 0;
          utterMs = speechMs;
          silenceMs = 0;
          let kept = 0;
          for (const c of utter) kept += c.length;
          utterStart = nowMs - samplesToMs(kept);
        }
      } else speechMs = 0;
      return { utterance: null, speaking: false, energy, hot };
    }
    utter.push(i16);
    utterMs += ms;
    if (hot) { speechMs += ms; silenceMs = 0; }
    else silenceMs += ms;
    if (utterMs < d.maxUtterMs && silenceMs < d.vadEndMs) {
      return { utterance: null, speaking: true, energy, hot };
    }
    const ok = speechMs >= d.minSpeechMs;
    const chunks = utter;
    const sm = speechMs;
    const tail = silenceMs;
    const tStart = utterStart;
    reset();
    if (!ok) return { utterance: null, speaking: false, energy, hot, dropped: true };
    let pcm = concatChunks(chunks);
    const keepTail = Math.round(d.keepTailSec * TARGET_RATE);
    const trim = Math.max(0, Math.round(tail / 1000 * TARGET_RATE) - keepTail);
    if (trim > 0 && trim < pcm.length) pcm = pcm.subarray(0, pcm.length - trim);
    // Frames can arrive in a burst. Never report the end before the start.
    const tEnd = Math.max(tStart, nowMs - Math.max(0, tail - d.keepTailSec * 1000));
    return {
      utterance: { pcm, speechMs: Math.round(sm), tailMs: Math.round(tail), tStart: Math.round(tStart), tEnd: Math.round(tEnd) },
      speaking: false, energy, hot,
    };
  }

  return {
    feed,
    reset,
    get speaking() { return active; },
    get noise() { return noise; },
  };
}

function concatChunks(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Int16Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

// your_turn only when nobody is talking and the pause has already happened.
export function turnHint(state) {
  const pause = state.pauseMs == null ? 700 : state.pauseMs;
  const speaking = state.speakingNow || [];
  if (state.selfSpeaking) return 'wait';
  if (speaking.length) return 'wait';
  if (state.pending) return 'wait';
  const silence = state.silenceMs;
  if (!(silence >= pause)) return 'wait';
  return 'your_turn';
}

// Whisper prints these on silence. Drop them so the agent does not answer a room that said nothing.
const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'bye', 'goodbye', 'the end', 'subtitles by', 'music', 'applause', 'silence',
  'blank audio', 'uh', 'um', 'hmm', 'mm', 'oh', 'ah',
]);

export function isHallucination(text) {
  const raw = String(text || '').trim();
  if (raw.length < 2) return true;
  const n = raw.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (n.length < 2) return true;
  if (HALLUCINATIONS.has(n)) return true;
  if (/^(thanks for watching|thank you for watching|subtitles by|transcribed by|please subscribe)/.test(n)) return true;
  return false;
}
