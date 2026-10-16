// The first clause is short so audio can start before the model finishes.

export function clauses(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const words = sentences[i].split(' ');
    if (out.length === 0 && words.length > 6) {
      let cut = 4;
      for (let w = 3; w < Math.min(words.length - 1, 8); w++) {
        if (/[,;:]$/.test(words[w]) || words[w].toLowerCase() === 'and') { cut = w + 1; break; }
      }
      const head = words.slice(0, cut).join(' ').replace(/[,;:]$/, '');
      out.push(/[.!?]$/.test(head) ? head : head + '.');
      const rest = words.slice(cut).join(' ').trim();
      if (rest) out.push(rest);
    } else {
      out.push(sentences[i]);
    }
  }
  return out;
}

// A finished clause is one that already has another clause after it, or the
// final clause once the model stops.
export function readyClauses(buffer, emitted, done) {
  const parts = clauses(buffer);
  let n = parts.length;
  if (!done && n > 0 && !/[.!?]"?$/.test(parts[n - 1])) n -= 1;
  if (n < emitted) n = emitted;
  return { parts, next: parts.slice(emitted, n), emitted: n };
}
