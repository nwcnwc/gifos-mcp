// One JSONL transcript per meeting, plus a plain-text view beside it.
// The meeting id is the only path segment, so a bad id cannot escape the folder.
import fs from 'node:fs';
import path from 'node:path';

export const MEETING_ID = /^m_[0-9a-f]+$/;
const KINDS = new Set(['speech', 'chat', 'bot', 'snapshot', 'event']);

export function meetingDir(home, id) {
  if (!MEETING_ID.test(String(id || ''))) throw new Error('bad meeting id');
  const root = path.resolve(home, 'meetings');
  const dir = path.resolve(root, id);
  if (dir !== path.join(root, id)) throw new Error('bad meeting id');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* the directory is already private */ }
  return dir;
}

export function readTranscript(home, id) {
  const file = path.join(meetingDir(home, id), 'transcript.jsonl');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

export class TranscriptLog {
  constructor(home, id) {
    this.dir = meetingDir(home, id);
    this.jsonl = path.join(this.dir, 'transcript.jsonl');
    this.txt = path.join(this.dir, 'transcript.txt');
    this.seq = 0;
    if (fs.existsSync(this.jsonl)) {
      const raw = fs.readFileSync(this.jsonl, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && row.seq > this.seq) this.seq = row.seq;
        } catch (e) { /* a torn last line is skipped */ }
      }
    }
  }

  append({ speaker, text, kind, ts, lane }) {
    if (!KINDS.has(kind)) throw new Error('bad transcript kind');
    this.seq += 1;
    const entry = {
      seq: this.seq,
      ts: Number(ts) || Date.now(),
      speaker: String(speaker || ''),
      text: String(text || ''),
      kind,
    };
    if (lane === 'stage' || lane === 'row' || lane === 'stadium') entry.lane = lane;
    fs.appendFileSync(this.jsonl, JSON.stringify(entry) + '\n', { mode: 0o600 });
    fs.appendFileSync(this.txt, entry.kind + '\t' + entry.speaker + ': ' + entry.text + '\n', { mode: 0o600 });
    return entry;
  }

  recent(n = 12) {
    if (!fs.existsSync(this.jsonl)) return [];
    const rows = [];
    for (const line of fs.readFileSync(this.jsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (e) { /* skip */ }
    }
    return rows.slice(-n);
  }
}
