// The live transcript the user's assistant tails. Speech comes from Meeting
// Bot's captions. Voice lines are what the speaking model said. Say lines are
// interjections from the assistant. The file is mode 0600 and never holds the
// API key (callers scrub before append).
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^m_[0-9a-f]+$/;

function splitLines(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

export function publicLine(row) {
  return { seq: row.seq, ts: row.ts, speaker: row.speaker, text: row.text, kind: row.kind };
}

export class LiveTranscript {
  constructor(home) {
    this.lines = [];
    this.seq = 0;
    this.snapshots = new Map();
    this.listeners = new Set();
    this.dir = home ? path.join(home, 'transcripts') : '';
    this.load();
  }

  load() {
    if (!this.dir || !fs.existsSync(this.dir)) return;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch (e) { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row || !row.meeting_id || !row.kind) continue;
          this.lines.push(row);
          if (row.seq > this.seq) this.seq = row.seq;
        } catch (e) { /* skip a torn line */ }
      }
    }
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  append(entry) {
    const row = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      meeting_id: entry.meeting_id,
      speaker: String(entry.speaker || ''),
      text: String(entry.text || ''),
      kind: entry.kind,
    };
    if (entry.source) row.source = entry.source;
    this.lines.push(row);
    this.persist(row);
    for (const fn of this.listeners) {
      try { fn(row); } catch (e) { /* a subscriber must not break the meeting */ }
    }
    return row;
  }

  persist(row) {
    if (!this.dir || !ID_RE.test(row.meeting_id)) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, row.meeting_id + '.jsonl');
    const fresh = !fs.existsSync(file);
    fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    if (fresh) fs.chmodSync(file, 0o600);
  }

  // Captions only grow during a meeting. A restart has no snapshot, so lines
  // already stored are not appended again.
  ingestCaption(meetingId, text, botName) {
    const raw = splitLines(text);
    const prev = this.snapshots.get(meetingId);
    let fresh = raw;
    if (prev === text) return [];
    if (typeof prev === 'string' && text.startsWith(prev)) {
      fresh = raw.slice(splitLines(prev).length);
    } else if (prev !== undefined) {
      const have = new Set(this.lines.filter((l) => l.meeting_id === meetingId && l.kind === 'speech').map((l) => l.source));
      fresh = raw.filter((line) => !have.has(line));
    } else {
      const have = new Set(this.lines.filter((l) => l.meeting_id === meetingId && l.kind === 'speech').map((l) => l.source));
      if (have.size) fresh = raw.filter((line) => !have.has(line));
    }
    this.snapshots.set(meetingId, String(text || ''));
    const added = [];
    const skip = String(botName || '').toLowerCase();
    for (const line of fresh) {
      const m = /^([^:]{1,80}):\s*(.*)$/.exec(line);
      if (!m) continue;
      const speaker = m[1].trim();
      const said = m[2].trim();
      if (!said) continue;
      if (skip && speaker.toLowerCase() === skip) continue;
      added.push(this.append({ meeting_id: meetingId, speaker, text: said, kind: 'speech', source: line }));
    }
    return added;
  }

  tail(meetingId, since) {
    const n = Number(since) || 0;
    const lines = this.lines.filter((l) => l.meeting_id === meetingId && l.seq > n).map(publicLine);
    return { meeting_id: meetingId, lines, next: lines.length ? lines[lines.length - 1].seq : n };
  }

  ndjson(meetingId) {
    return this.lines.filter((l) => l.meeting_id === meetingId).map((l) => JSON.stringify(publicLine(l))).join('\n');
  }

  meetings() {
    return [...new Set(this.lines.map((l) => l.meeting_id))];
  }
}

// Polls Meeting Bot's caption text while a meeting is live.
export function watchCaptions({ meetings, bot, live, intervalMs, botName }) {
  const timers = new Map();
  const gap = intervalMs > 0 ? intervalMs : 500;
  async function tick(id) {
    const m = meetings.get(id);
    if (!m || m.state !== 'live' || !m.session_id) return;
    try {
      const text = await bot.transcript(m.session_id);
      live.ingestCaption(m.meeting_id, text, botName);
    } catch (e) { /* the next poll retries */ }
  }
  return {
    start(meeting) {
      this.stop(meeting.meeting_id);
      const timer = setInterval(() => { tick(meeting.meeting_id); }, gap);
      if (timer.unref) timer.unref();
      timers.set(meeting.meeting_id, timer);
      return tick(meeting.meeting_id);
    },
    stop(id) {
      const timer = timers.get(id);
      if (timer) clearInterval(timer);
      timers.delete(id);
    },
    stopAll() {
      for (const id of [...timers.keys()]) this.stop(id);
    },
  };
}
