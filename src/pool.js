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
// - A worker that stops answering the heartbeat is killed and counts as lost.
// - A call that gets no answer within callMs (joinMs for a browser start or
//   a join) fails, but a worker that still answers the heartbeat stays up.
//   A join that lands after its caller gave up is left at once.
// - A worker that keeps dying waits longer before each restart (1s, 2s, 4s,
//   up to a minute), and joins go to another worker meanwhile.
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.js', import.meta.url));
const SESSION_RE = /^w(\d+):(.+)$/;
// Calls that may start a browser or wait on a meeting page get joinMs.
const SLOW_METHODS = new Set(['ensureStarted', 'join']);

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
    this.late = new Map();    // call id -> method, for calls that timed out
    this.rooms = new Set();   // local session ids seated on this worker
    this.reserved = 0;        // joins in flight
    this.booting = null;
    this.voice = null;
    this.failures = 0;        // deaths in a row, for the restart backoff
    this.nextStartAt = 0;     // pool.now() before which spawn() refuses
    this.upAt = 0;
    this.lastPong = 0;
    this.beat = null;
  }

  get used() { return this.rooms.size + this.reserved; }

  restartInMs() {
    return this.state === 'lost' ? Math.max(0, this.nextStartAt - this.pool.now()) : 0;
  }

  waitText() {
    return 'Worker ' + this.index + ' restarts in ' + Math.ceil(this.restartInMs() / 1000) + 's (it stopped: ' + this.error + ').';
  }

  spawn() {
    if (this.booting) return this.booting;
    if (this.restartInMs() > 0) return Promise.reject(new Error(this.waitText()));
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
        if (msg.event === 'up') { up = true; this.state = 'up'; this.upAt = this.pool.now(); this.heartbeat(child); resolve(); return; }
        if (msg.event === 'pong') { this.lastPong = Date.now(); return; }
        if (msg.event === 'thinking') { this.pool.thinkingFrom(this.index, msg.id, msg.on); return; }
        if (msg.id != null && this.late.has(msg.id)) { this.landedLate(msg); return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
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

  // A wedged event loop answers no call, so a ping that goes unanswered for
  // stuckMs kills the child. exit then runs lost() as for any crash.
  heartbeat(child) {
    this.lastPong = Date.now();
    this.beat = setInterval(() => {
      if (this.child !== child) return;
      const quiet = Date.now() - this.lastPong;
      if (quiet > this.pool.stuckMs) {
        this.error = 'worker ' + this.index + ' stopped answering (no heartbeat for ' + quiet + 'ms)';
        clearInterval(this.beat);
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        return;
      }
      try { child.send({ type: 'ping' }); } catch (e) { /* exit follows */ }
    }, this.pool.heartbeatMs);
    this.beat.unref();
  }

  lost(why) {
    const was = this.state;
    clearInterval(this.beat);
    this.beat = null;
    if (was !== 'closing') {
      // A worker that stayed up for stableMs starts the backoff over.
      const now = this.pool.now();
      if (this.upAt && now - this.upAt >= this.pool.stableMs) this.failures = 0;
      this.failures++;
      this.nextStartAt = now + Math.min(this.pool.backoffMaxMs, this.pool.backoffMs * 2 ** (this.failures - 1));
    }
    this.upAt = 0;
    this.state = was === 'closing' ? 'stopped' : 'lost';
    if (was !== 'closing') this.error = why;
    this.child = null;
    this.booting = null;
    this.late.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker ' + this.index + ' stopped: ' + why)); }
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
    const ms = SLOW_METHODS.has(method) ? this.pool.joinMs : this.pool.callMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.late.set(id, method);
        reject(new Error('Worker ' + this.index + ' did not answer ' + method + ' within ' + ms + 'ms.'));
      }, ms);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.send({ type: 'call', id, method, args }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // A reply to a call that already timed out. Nobody holds the session id of
  // a late join, so leave it rather than keep a seat no one can reach.
  landedLate(msg) {
    const method = this.late.get(msg.id);
    this.late.delete(msg.id);
    if (method !== 'join' || !msg.ok || msg.value == null) return;
    const local = String(msg.value);
    log('worker ' + this.index + ': a join landed after it timed out; leaving ' + local);
    this.call('leave', local).catch((e) => log('worker ' + this.index + ': late leave failed: ' + ((e && e.message) || e)));
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
    clearInterval(this.beat);
    const exited = new Promise((r) => child.once('exit', r));
    try { child.send({ type: 'close' }); } catch (e) { /* already gone */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, this.pool.closeMs);
    await exited;
    clearTimeout(t);
  }
}

export class WorkerPool {
  // opts: { workers, rooms, onThinking(sessionId, on), onLost(sessionIds, why), forkWorker(index), closeMs,
  //         now(), heartbeatMs, stuckMs, backoffMs, backoffMaxMs, stableMs, callMs, joinMs }
  constructor(cfg, creds, opts = {}) {
    this.cfg = cfg;
    this.creds = creds;
    this.size = opts.workers > 0 ? opts.workers : 1;
    this.rooms = opts.rooms > 0 ? opts.rooms : Math.max(1, Math.ceil((cfg.maxMeetings || 1) / this.size));
    this.onThinking = typeof opts.onThinking === 'function' ? opts.onThinking : () => {};
    this.lostHooks = [];
    if (typeof opts.onLost === 'function') this.lostHooks.push(opts.onLost);
    this.closeMs = opts.closeMs > 0 ? opts.closeMs : 10000;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.heartbeatMs = opts.heartbeatMs > 0 ? opts.heartbeatMs : 5000;
    this.stuckMs = opts.stuckMs > 0 ? opts.stuckMs : 30000;
    this.backoffMs = opts.backoffMs > 0 ? opts.backoffMs : 1000;
    this.backoffMaxMs = opts.backoffMaxMs > 0 ? opts.backoffMaxMs : 60000;
    this.stableMs = opts.stableMs > 0 ? opts.stableMs : 60000;
    // A browser start chains several page waits of cfg.timeoutMs each.
    this.callMs = opts.callMs > 0 ? opts.callMs : 60000;
    this.joinMs = opts.joinMs > 0 ? opts.joinMs : 5 * (cfg.timeoutMs || 120000);
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
    const open = this.workers.filter((w) => w.used < this.rooms && w.restartInMs() === 0);
    if (!open.length) return null;
    const warm = (w) => (w.state === 'ready' || w.state === 'up' ? 0 : 1);
    open.sort((a, b) => warm(a) - warm(b) || a.used - b.used || a.index - b.index);
    return open[0];
  }

  async join(link, password) {
    const w = this.pick();
    const waiting = !w && this.workers.find((x) => x.used < this.rooms && x.restartInMs() > 0);
    if (waiting) throw new Error(waiting.waitText());
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
      if (w.restartInMs() > 0) row.restart_in_ms = w.restartInMs();
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
