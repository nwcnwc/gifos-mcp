// Word error rate. Punctuation and case are ignored. Used by the STT bench
// and by tests that only care that the words came through.

export function wordsOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

export function wer(reference, hypothesis) {
  const r = wordsOf(reference);
  const h = wordsOf(hypothesis);
  const n = r.length, m = h.length;
  if (!n) return m ? 1 : 0;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[n][m] / n;
}

export function keywordHits(text, words) {
  const n = ' ' + wordsOf(text).join(' ') + ' ';
  return words.filter((w) => n.includes(' ' + String(w).toLowerCase() + ' '));
}
