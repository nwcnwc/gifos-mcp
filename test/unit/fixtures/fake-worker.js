// A stage B worker with a fake Meet Bot, forked by stage-b.test.js. Same IPC
// protocol and serveWorker as src/worker.js; no browser.
import fs from 'node:fs';
import path from 'node:path';
import { serveWorker } from '../../../src/worker.js';

class FakeDriver {
  constructor(queue, boot) {
    this.queue = queue;
    this.boot = boot;
    this.log = [];
    this.seq = 0;
    this.live = new Set();    // rooms Meet Bot holds, as its list() shows them
  }
  // A started browser keeps the worker's event loop alive, as Chromium does.
  async ensureStarted() {
    this.log.push(['ensureStarted']);
    // cfg.failStart lists workers whose browser will not start, until fixStart().
    if ((this.boot.cfg.failStart || []).includes(this.boot.index) && !this.startFixed) throw new Error('Chromium would not start on worker ' + this.boot.index);
    if (!this.browser) this.browser = setInterval(() => {}, 1000);
  }
  async join(link, password) {
    this.log.push(['join', link, password]);
    if (this.held) await this.held.promise;
    if (this.joinFails) throw new Error(this.joinFails);
    const id = 'mt_' + (++this.seq);
    this.live.add(id);
    // Meet Bot took the room, but the answer never gets back.
    if (this.stalled) return new Promise(() => {});
    return id;
  }
  async leave(id) {
    this.log.push(['leave', id]);
    if (this.leaveHeld) await this.leaveHeld.promise;
    if (this.leaveFails) throw new Error(this.leaveFails);
    this.live.delete(id);
  }
  async transcribe(id, on) { this.log.push(['transcribe', id, on]); }
  async say(id, text) { this.log.push(['say', id, text]); }
  async interject(id, text) {
    this.log.push(['interject', id, text]);
    // Meet Bot captions its own speech under the name this worker sits as.
    this.spoken = this.spoken || {};
    (this.spoken[id] = this.spoken[id] || []).push(this.boot.creds.name + ': ' + text);
    return { applied: true };
  }
  async transcript(id) {
    return ['Ada: hello from ' + this.boot.creds.name + ' ' + id].concat((this.spoken && this.spoken[id]) || []).join('\n');
  }
  async people() { return [{ name: 'Ada', bot: false }]; }
  async setVoice(s) {
    this.log.push(['setVoice', s]);
    if (this.voiceHeld) return new Promise(() => {});
    if (this.voiceFails) throw new Error('setVoice refused');
    return { applied: true };
  }
  async list() { return [...this.live].map((id) => ({ id })); }
  async info() {
    if (this.infoStuck) return new Promise(() => {});
    return { state: 'ready', connected: true, bot_name: this.boot.creds.name, bot_sessions: [] };
  }
  async close() {
    clearInterval(this.browser);
    this.browser = null;
    fs.writeFileSync(path.join(this.boot.cfg.home, 'closed-w' + this.boot.index), String(process.pid));
  }
  // Test-only methods, allowed by the extra list below.
  async calls() { return this.log; }
  async whoami() { return { name: this.boot.creds.name, profile: this.boot.cfg.profile, argv: process.argv, env: Object.keys(process.env).filter((k) => String(process.env[k]).includes(this.boot.creds.password)) }; }
  async think(id, on) { this.queue.setThinking(id, on); }
  async slow() { return new Promise(() => {}); }
  // Joins wait until releaseJoins(), so a test can time one out and then let it land.
  async holdJoins() { let release; const promise = new Promise((r) => { release = r; }); this.held = { promise, release }; }
  async releaseJoins() { const h = this.held; this.held = null; if (h) h.release(); }
  // Joins seat the bot in the room but never answer.
  async stallJoins() { this.stalled = true; }
  // join fails with this text from now on.
  async breakJoin(text) { this.joinFails = String(text); }
  // leave fails with this text until fixLeave().
  async breakLeave(text) { this.leaveFails = String(text); }
  async fixLeave() { this.leaveFails = null; }
  // Leaves wait until releaseLeaves().
  async holdLeaves() { let release; const promise = new Promise((r) => { release = r; }); this.leaveHeld = { promise, release }; }
  async releaseLeaves() { const h = this.leaveHeld; this.leaveHeld = null; if (h) h.release(); }
  // info never answers, while pings and other calls still do.
  async stickInfo() { this.infoStuck = true; }
  // setVoice fails until fixVoice().
  async breakVoice() { this.voiceFails = true; }
  async fixVoice() { this.voiceFails = false; }
  // setVoice never answers.
  async holdVoice() { this.voiceHeld = true; }
  async fixStart() { this.startFixed = true; }
  // Blocks the event loop for good, the way a wedged worker would: no reply, no pong.
  async hang() { for (;;) { /* stuck */ } }
}

process.once('message', (boot) => {
  serveWorker(process, (queue) => new FakeDriver(queue, boot), ['calls', 'whoami', 'think', 'slow', 'hang', 'holdJoins', 'releaseJoins', 'stallJoins', 'breakJoin', 'stickInfo', 'breakVoice', 'fixVoice', 'holdVoice', 'breakLeave', 'fixLeave', 'holdLeaves', 'releaseLeaves', 'fixStart']);
});
process.send({ event: 'boot' });
