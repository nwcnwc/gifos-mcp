// The display name humans read on the tile. GifOS keeps 40 UTF-16 code units.
// The robot marker is the visible "this is an AI" badge and must survive that cut.

const BADGE = '🤖';
const LIMIT = 40;

export function withAiBadge(name) {
  let s = String(name || '').trim();
  if (!s) s = 'Assistant';
  if (!s.includes(BADGE)) s = s + ' ' + BADGE;
  if (s.length <= LIMIT) return s;
  const tail = ' ' + BADGE;
  const keep = Math.max(1, LIMIT - tail.length);
  return s.slice(0, keep).trimEnd() + tail;
}

export function isSelfName(speaker, selfName) {
  const a = String(speaker || '').trim();
  const b = String(selfName || '').trim();
  if (!a || !b) return false;
  return a === b;
}
