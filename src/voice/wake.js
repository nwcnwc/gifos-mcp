// Speech-to-text often hears the wake word "bot" as "Bart". A line that
// starts the way "hey bot" does, with a close variant, is addressed to the
// bot. A direct question is answered even when the name was lost.

export const WAKE_RE = /^(?:hey |ok |hi |hello )?(?:bot|bart|bott|bots|bought)\b/i;
export const QUESTION_RE = /^(?:what|who|when|where|why|how|which|can you|could you|would you|will you)\b/i;

export function hearsWake(text, name) {
  const t = String(text || '').trim();
  if (!t) return false;
  const n = String(name || '').trim().toLowerCase();
  if (n && t.toLowerCase().includes(n)) return true;
  return WAKE_RE.test(t);
}

export function isDirectQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return QUESTION_RE.test(t);
}
