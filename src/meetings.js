// The meetings this server knows about, kept in GIFOS_MCP_HOME/meetings.json
// so a restart (or a 5 PM routine on a server started at boot) still finds
// the meeting created this morning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOM_RE = /^[A-Za-z0-9-]{1,64}$/;

function stripSecrets(fields) {
  const out = { ...(fields || {}) };
  delete out.room_password;
  delete out.admin_password;
  delete out.password;
  return out;
}

export function newRoom() {
  // 120 random bits. The room name is what the meeting key derives from.
  const b = crypto.randomBytes(15);
  let n = BigInt('0x' + b.toString('hex'));
  let s = '';
  while (s.length < 24) { s += (n % 36n).toString(36); n /= 36n; }
  return s;
}

export function linkFor(gifosUrl, room, relay) {
  return gifosUrl + '/run.html#v=' + room + (relay ? '&relay=' + encodeURIComponent(relay) : '');
}

// Accepts the links GifOS hands out: /run.html#v=<room>[&...] and /meet/<room>.
export function roomFromLink(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const pretty = /^\/(?:meet|cast)\/([A-Za-z0-9-]{1,64})\/?$/.exec(u.pathname);
  if (pretty) return pretty[1];
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  const v = h.get('v') || '';
  return ROOM_RE.test(v) ? v : '';
}

export class MeetingStore {
  constructor(home) {
    this.file = path.join(home, 'meetings.json');
    this.home = home;
    this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).meetings || []; } catch (e) { this.items = []; }
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ meetings: this.items }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.items.find((m) => m.meeting_id === id) || null; }
  byRoom(room) { return this.items.find((m) => m.room === room && m.state !== 'ended') || null; }
  all() { return this.items.slice(); }

  add(fields) {
    const m = {
      meeting_id: 'm_' + crypto.randomBytes(5).toString('hex'),
      topic: '',
      start_time: null,
      link: '',
      room: '',
      state: 'scheduled',
      session_id: null,
      transcribing: false,
      muted: false,
      transcript: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      thinking: false,
      ...stripSecrets(fields),
    };
    this.items.push(m);
    this.save();
    return m;
  }

  // A new process has a new browser, so no meeting is live any more. Each one
  // goes back to scheduled and start_meeting can bring the bot back.
  resetLive() {
    let n = 0;
    for (const m of this.items) {
      if (m.state !== 'live') continue;
      Object.assign(m, { state: 'scheduled', session_id: null, transcribing: false });
      n++;
    }
    if (n) this.save();
    return n;
  }

  update(id, fields) {
    const m = this.get(id);
    if (!m) return null;
    Object.assign(m, stripSecrets(fields));
    this.save();
    return m;
  }
}

// What a tool returns about a meeting: never the cached transcript body.
export function publicView(m) {
  return {
    meeting_id: m.meeting_id,
    topic: m.topic,
    start_time: m.start_time,
    link: m.link,
    state: m.state,
    transcribing: !!m.transcribing,
    muted: !!m.muted,
    thinking: !!m.thinking,
    created_at: m.created_at,
    started_at: m.started_at,
    ended_at: m.ended_at,
  };
}
