// Ordered events for the whole connector. The file is mode 0600.
// Callers scrub secrets before append. This log does not accept an admin password.
import fs from 'node:fs';
import path from 'node:path';

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export class EventLog {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'events.jsonl');
    this.items = [];
    this.seq = 0;
    this.load();
  }

  load() {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || !row.type) continue;
        if (row.admin_password || (row.data && row.data.admin_password)) continue;
        this.items.push(row);
        if (row.seq > this.seq) this.seq = row.seq;
      } catch (e) { /* torn line */ }
    }
  }

  append({ type, meeting_id, data }) {
    const clean = data && typeof data === 'object' ? { ...data } : {};
    delete clean.admin_password;
    delete clean.room_password;
    delete clean.password;
    const row = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      meeting_id: meeting_id || '',
      type: String(type),
      data: clean,
    };
    this.items.push(row);
    this.persist(row);
    return row;
  }

  persist(row) {
    if (!this.home) return;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const fresh = !fs.existsSync(this.file);
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    if (fresh) fs.chmodSync(this.file, 0o600);
  }

  tail(since) {
    const n = Number(since) || 0;
    const events = this.items.filter((row) => row.seq > n);
    return { since: n, next: events.length ? events[events.length - 1].seq : n, events };
  }

  replace(items) {
    this.items = items;
    this.seq = items.reduce((max, row) => Math.max(max, row.seq || 0), 0);
    if (!this.home) return;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivate(this.file, items.map((row) => JSON.stringify(row)).join('\n') + (items.length ? '\n' : ''));
  }
}
