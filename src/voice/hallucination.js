// Whisper prints stock phrases on a quiet tail ("so long friends.") when
// the samples are near silence. A loud clip that really says the phrase
// is kept. Energy is the mean absolute PCM16 sample. Unknown audio, which
// this process cannot measure, is not treated as silence.

export const LOW_ENERGY = 80;

const FAMOUS = [
  'so long friends',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'see you in the next video',
  'thanks for listening',
  'subtitles by the amara.org community',
];

const SHORT = ['thank you', 'thanks', 'you', 'bye', 'goodbye', 'so long'];

export const HALLUCINATION_PHRASES = FAMOUS.concat(SHORT);
const ALL = new Set(HALLUCINATION_PHRASES);
const FAMOUS_SET = new Set(FAMOUS);

export function normalizeCaption(text) {
  return String(text || '').toLowerCase().replace(/[,.!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isHallucination(text) {
  return ALL.has(normalizeCaption(text));
}

// A whole caption line that is only one of the stock silent-tail phrases.
// Short words people actually say ("thanks", "you") stay; those need the
// audio measurement in heardText.
export function isCaptionHallucination(text) {
  return FAMOUS_SET.has(normalizeCaption(text));
}

export function pcm16Energy(audio) {
  if (audio == null) return null;
  const b = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  if (!b.length) return 0;
  let start = 0;
  let end = b.length;
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') {
    let o = 12;
    let found = false;
    while (o + 8 <= b.length) {
      const id = b.toString('ascii', o, o + 4);
      const size = b.readUInt32LE(o + 4);
      if (id === 'data') {
        start = o + 8;
        end = Math.min(b.length, start + size);
        found = true;
        break;
      }
      const step = 8 + size + (size % 2);
      if (step <= 0) break;
      o += step;
    }
    if (!found) return null;
  }
  const n = Math.floor((end - start) / 2);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(b.readInt16LE(start + i * 2));
  return sum / n;
}

export function heardText(text, audio) {
  const said = String(text || '').trim();
  if (!said) return '';
  if (!isHallucination(said)) return said;
  const energy = pcm16Energy(audio);
  if (energy == null) return said;
  if (energy >= LOW_ENERGY) return said;
  return '';
}
