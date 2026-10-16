// The meetings this server knows about, kept in GIFOS_MCP_HOME/meetings.json
// so a restart (or a 5 PM routine on a server started at boot) still finds
// the meeting created this morning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOM_RE = /^[A-Za-z0-9-]{1,64}$/;

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

// localStorage key the meeting page reads in loadPw() before it derives the
// room key. The room id keeps its case; a verifier (av) is folded to hex.
// An invalid av is ignored, matching run.html.
export function passwordStorageKey(link) {
  const id = passwordRoomId(link);
  if (!id.room) return '';
  return 'gifos_vpw_' + id.room + (id.av ? '.' + id.av : '');
}

export function passwordRoomId(link) {
  const raw = String(link || '').trim();
  let u = null;
  try { u = new URL(raw); } catch (e) { u = null; }
  let room = '';
  let av = '';
  if (u && (u.protocol === 'https:' || u.protocol === 'http:')) {
    const pretty = /^\/(?:meet|cast|join)\/([A-Za-z0-9-]{1,64})(?:\/([A-Fa-f0-9]{16,64}))?\/?$/.exec(u.pathname);
    if (pretty) { room = pretty[1]; av = (pretty[2] || '').toLowerCase(); }
    const h = new URLSearchParams(u.hash.replace(/^#/, ''));
    const v = h.get('v') || '';
    if (ROOM_RE.test(v)) room = v;
    if (h.get('av')) av = h.get('av').toLowerCase();
  } else {
    const bare = /^([A-Za-z0-9-]{1,64})(?:[./]([A-Fa-f0-9]{16,64}))?$/.exec(raw);
    if (bare) { room = bare[1]; av = (bare[2] || '').toLowerCase(); }
  }
  if (av && !/^[a-f0-9]{16,64}$/.test(av)) av = '';
  if (!ROOM_RE.test(room)) return { room: '', av: '' };
  return { room, av };
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
    fs.chmodSync(this.home, 0o700);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ meetings: this.items }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    // rename keeps the tmp mode, but a following chmod is the guarantee: a
    // meeting password lives in this file and nowhere else.
    fs.chmodSync(this.file, 0o600);
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
      ...fields,
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
    Object.assign(m, fields);
    this.save();
    return m;
  }
}

// What a tool returns about a meeting: never the cached transcript body,
// and never the room password. `locked` is only a boolean.
export function publicView(m) {
  return {
    meeting_id: m.meeting_id,
    topic: m.topic,
    start_time: m.start_time,
    link: m.link,
    state: m.state,
    transcribing: !!m.transcribing,
    muted: !!m.muted,
    locked: !!m.password,
    created_at: m.created_at,
    started_at: m.started_at,
    ended_at: m.ended_at,
  };
}
