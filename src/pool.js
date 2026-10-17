// Stage B supervisor: several workers on one machine. Each worker is a child
// process with one Chromium and one Meet Bot (worker.js). This object has the
// same surface as MeetingBotDriver, so server.js and the clock do not change.
//
// - A join goes to the ready worker with the most free rooms, chosen when the
//   window opens, not at the start of the day.
// - The session id handed back is "w<index>:<worker session id>". The
//   meeting is sticky to that worker until it leaves. say, transcript, leave,
//   and every per-meeting call route by that prefix.
// - A worker that exits loses its rooms. onLost hears their session ids so
//   the meeting index can drop them, and the clock rejoins live orders on a
//   worker that is still up.
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.js', import.meta.url));
const SESSION_RE = /^w(\d+):(.+)$/;

// Worker 0 keeps the bot's own name and profile, so a one-worker machine
// that moves to several keeps its installed apps. Worker n is its own bot
// (open question 6): a second RUN with the same name and password would be
// refused as "already running".
export function workerIdentity(cfg, creds, index) {
  if (index === 0) return { profile: 'profile-bot', creds: { ...creds } };
  const tag = '-w' + index;
  return {
    profile: 'profile-bot' + tag,
    creds: { ...creds, name: String(creds.name).slice(0, 40 - tag.length) + tag },
  };
}

export function splitSession(sessionId) {
  const m = SESSION_RE.exec(String(sessionId || ''));
  if (!m) return null;
  return { index: Number(m[1]), local: m[2] };
}

class Worker {
  constructor(pool, index) {
    this.pool = pool;
    this.index = index;
    this.child = null;
    this.state = 'stopped';
    this.error = '';
    this.seq = 0;
    this.pending = new Map();
    this.rooms = new Set();   // local session ids seated on this worker
    this.reserved = 0;        // joins in flight
    this.booting = null;
    this.voice = null;
  }

  get used() { return this.rooms.size + this.reserved; }

  spawn() {
    if (this.booting) return this.booting;
    const id = workerIdentity(this.pool.cfg, this.pool.creds, this.index);
    const shots = this.pool.cfg.shotsDir || path.join(this.pool.cfg.home, 'shots');
    const cfg = { ...this.pool.cfg, profile: id.profile, shotsDir: this.index === 0 ? this.pool.cfg.shotsDir : path.join(shots, 'w' + this.index) };
    this.botName = id.creds.name;
    this.state = 'starting';
    this.error = '';
    this.booting = new Promise((resolve, reject) => {
      const child = this.pool.forkWorker(this.index);
      this.child = child;
      let up = false;
      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.event === 'boot') { child.send({ type: 'boot', cfg, creds: id.creds, index: this.index }); return; }
        if (msg.event === 'up') { up = true; this.state = 'up'; resolve(); return; }
        if (msg.event === 'thinking') { this.pool.thinkingFrom(this.index, msg.id, msg.on); return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error || 'The worker call failed.'));
        }
      });
      child.on('error', (e) => { this.error = String((e && e.message) || e); });
      child.on('exit', (code, signal) => {
        const why = this.error || ('worker ' + this.index + ' exited' + (signal ? ' (' + signal + ')' : ' (code ' + code + ')'));
        this.lost(why);
        if (!up) reject(new Error(why));
      });
    });
    return this.booting;
  }

  lost(why) {
    const was = this.state;
    this.state = was === 'closing' ? 'stopped' : 'lost';
    if (was !== 'closing') this.error = why;
    this.child = null;
    this.booting = null;
    for (const p of this.pending.values()) p.reject(new Error('Worker ' + this.index + ' stopped: ' + why));
    this.pending.clear();
    const gone = [...this.rooms].map((s) => 'w' + this.index + ':' + s);
    this.rooms.clear();
    if (was !== 'closing') {
      log('worker ' + this.index + ' lost: ' + why + (gone.length ? '; ' + gone.length + ' meeting(s) dropped' : ''));
      this.pool.lostFrom(this.index, gone, why);
    }
  }

  async call(method, ...args) {
    await this.spawn();
    if (!this.child) throw new Error('Worker ' + this.index + ' is not running.');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.child.send({ type: 'call', id, method, args }); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  async ready() {
    await this.call('ensureStarted');
    if (this.state === 'up') this.state = 'ready';
    if (this.pool.voice && this.voice !== this.pool.voice) {
      this.voice = this.pool.voice;
      await this.call('setVoice', this.pool.voice).catch(() => {});
    }
  }

  async close() {
    if (!this.child) { this.state = 'stopped'; return; }
    const child = this.child;
    this.state = 'closing';
    const exited = new Promise((r) => child.once('exit', r));
    try { child.send({ type: 'close' }); } catch (e) { /* already gone */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, this.pool.closeMs);
    await exited;
    clearTimeout(t);
  }
}

export class WorkerPool {
  // opts: { workers, rooms, onThinking(sessionId, on), onLost(sessionIds, why), forkWorker(index), closeMs }
  constructor(cfg, creds, opts = {}) {
    this.cfg = cfg;
    this.creds = creds;
    this.size = opts.workers > 0 ? opts.workers : 1;
    this.rooms = opts.rooms > 0 ? opts.rooms : Math.max(1, Math.ceil((cfg.maxMeetings || 1) / this.size));
    this.onThinking = typeof opts.onThinking === 'function' ? opts.onThinking : () => {};
    this.lostHooks = [];
    if (typeof opts.onLost === 'function') this.lostHooks.push(opts.onLost);
    this.closeMs = opts.closeMs > 0 ? opts.closeMs : 10000;
    const script = opts.workerScript || WORKER_SCRIPT;
    this.forkWorker = typeof opts.forkWorker === 'function'
      ? opts.forkWorker
      : () => fork(script, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.workers = Array.from({ length: this.size }, (_, i) => new Worker(this, i));
    this.thinking = new Set();
    this.voice = null;
    const pool = this;
    // What server.js reads as bot.queue: thinking per session, leave drops it.
    this.queue = {
      isThinking(id) { return pool.thinking.has(String(id || '')); },
      leave(id) { pool.setThinking(String(id || ''), false); },
    };
  }

  onLost(fn) {
    this.lostHooks.push(fn);
    return () => { this.lostHooks = this.lostHooks.filter((f) => f !== fn); };
  }

  setThinking(id, on) {
    if (!id) return;
    const prev = this.thinking.has(id);
    if (prev === !!on) return;
    if (on) this.thinking.add(id); else this.thinking.delete(id);
    try { this.onThinking(id, !!on); } catch (e) { /* the call still finishes */ }
  }

  thinkingFrom(index, local, on) {
    this.setThinking('w' + index + ':' + local, on);
  }

  lostFrom(index, sessionIds, why) {
    for (const id of sessionIds) this.setThinking(id, false);
    for (const fn of this.lostHooks) {
      try { fn(sessionIds, why, index); } catch (e) { log('lost hook: ' + ((e && e.message) || e)); }
    }
  }

  // Warm the first worker so the first join does not wait for a browser.
  async ensureStarted() {
    const up = this.workers.find((w) => w.state === 'ready');
    if (up) return;
    await this.workers[0].ready();
  }

  // Most free rooms first. A worker that is already up beats one that would
  // have to start, so the second room does not wait for a second browser.
  pick() {
    const open = this.workers.filter((w) => w.used < this.rooms);
    if (!open.length) return null;
    const warm = (w) => (w.state === 'ready' || w.state === 'up' ? 0 : 1);
    open.sort((a, b) => warm(a) - warm(b) || a.used - b.used || a.index - b.index);
    return open[0];
  }

  async join(link, password) {
    const w = this.pick();
    if (!w) throw new Error('Every worker is full (' + this.size + ' workers, ' + this.rooms + ' rooms each).');
    w.reserved++;
    try {
      await w.ready();
      const local = await w.call('join', link, password || '');
      w.rooms.add(String(local));
      return 'w' + w.index + ':' + local;
    } finally {
      w.reserved--;
    }
  }

  route(sessionId) {
    const s = splitSession(sessionId);
    const w = s && this.workers[s.index];
    if (!w || !w.rooms.has(s.local)) throw new Error('No worker holds session ' + JSON.stringify(String(sessionId)) + '.');
    return { w, local: s.local };
  }

  async leave(sessionId) {
    const { w, local } = this.route(sessionId);
    this.setThinking(String(sessionId), false);
    try { await w.call('leave', local); }
    finally { w.rooms.delete(local); }
  }

  async transcribe(id, on) { const r = this.route(id); return r.w.call('transcribe', r.local, !!on); }
  async say(id, text) { const r = this.route(id); return r.w.call('say', r.local, String(text)); }
  async people(id) { const r = this.route(id); return r.w.call('people', r.local); }
  async transcript(id) { const r = this.route(id); return r.w.call('transcript', r.local); }
  async interject(id, text) { const r = this.route(id); return r.w.call('interject', r.local, String(text)); }
  async raiseHand(id, on) { const r = this.route(id); return r.w.call('raiseHand', r.local, !!on); }
  async setMic(id, on) { const r = this.route(id); return r.w.call('setMic', r.local, !!on); }
  async setCamera(id, on) { const r = this.route(id); return r.w.call('setCamera', r.local, !!on); }
  async meetingState(id) { const r = this.route(id); return r.w.call('meetingState', r.local); }
  async snapshot(id) { const r = this.route(id); return r.w.call('snapshot', r.local); }

  async list() {
    const out = [];
    for (const w of this.workers) {
      if (w.state !== 'ready') continue;
      const rows = await w.call('list').catch(() => []);
      for (const row of rows || []) out.push({ ...row, id: 'w' + w.index + ':' + row.id, worker: w.index });
    }
    return out;
  }

  // Voice switches stay global (open question 7). A worker that starts
  // later gets the same settings in ready().
  async setVoice(settings) {
    this.voice = settings;
    let first = null;
    for (const w of this.workers) {
      if (w.state !== 'ready') continue;
      w.voice = settings;
      const r = await w.call('setVoice', settings);
      if (!first) first = r;
    }
    return first || { applied: true, result: null };
  }

  async info() {
    const workers = [];
    const sessions = [];
    for (const w of this.workers) {
      const row = { worker: w.index, state: w.state, rooms: w.rooms.size, budget: this.rooms };
      if (w.botName) row.bot_name = w.botName;
      if (w.error) row.error = w.error;
      if (w.state === 'ready') {
        try {
          const inf = await w.call('info');
          row.connected = !!(inf && inf.connected);
          for (const s of (inf && inf.bot_sessions) || []) sessions.push({ ...s, session_id: 'w' + w.index + ':' + s.session_id, worker: w.index });
        } catch (e) { row.error = String((e && e.message) || e); }
      }
      workers.push(row);
    }
    const ready = workers.filter((r) => r.state === 'ready').length;
    return {
      state: ready ? 'ready' : (workers.some((r) => r.state === 'starting' || r.state === 'up') ? 'starting' : 'stopped'),
      bot_name: this.creds.name,
      workers,
      bot_sessions: sessions,
    };
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
