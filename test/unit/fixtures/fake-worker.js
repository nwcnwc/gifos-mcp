// A stage B worker with a fake Meet Bot, forked by stage-b.test.js. Same IPC
// protocol and serveWorker as src/worker.js; no browser.
import { serveWorker } from '../../../src/worker.js';

class FakeDriver {
  constructor(queue, boot) {
    this.queue = queue;
    this.boot = boot;
    this.log = [];
    this.seq = 0;
  }
  async ensureStarted() { this.log.push(['ensureStarted']); }
  async join(link, password) {
    this.log.push(['join', link, password]);
    if (this.held) await this.held.promise;
    return 'mt_' + (++this.seq);
  }
  async leave(id) { this.log.push(['leave', id]); }
  async transcribe(id, on) { this.log.push(['transcribe', id, on]); }
  async say(id, text) { this.log.push(['say', id, text]); }
  async interject(id, text) { this.log.push(['interject', id, text]); return { applied: true }; }
  async transcript(id) { return 'Ada: hello from ' + this.boot.creds.name + ' ' + id; }
  async people() { return [{ name: 'Ada', bot: false }]; }
  async setVoice(s) { this.log.push(['setVoice', s]); return { applied: true }; }
  async list() { return Array.from({ length: this.seq }, (_, i) => ({ id: 'mt_' + (i + 1) })); }
  async info() { return { state: 'ready', connected: true, bot_name: this.boot.creds.name, bot_sessions: [] }; }
  async close() {}
  // Test-only methods, allowed by the extra list below.
  async calls() { return this.log; }
  async whoami() { return { name: this.boot.creds.name, profile: this.boot.cfg.profile, argv: process.argv, env: Object.keys(process.env).filter((k) => String(process.env[k]).includes(this.boot.creds.password)) }; }
  async think(id, on) { this.queue.setThinking(id, on); }
  async slow() { return new Promise(() => {}); }
  // Joins wait until releaseJoins(), so a test can time one out and then let it land.
  async holdJoins() { let release; const promise = new Promise((r) => { release = r; }); this.held = { promise, release }; }
  async releaseJoins() { const h = this.held; this.held = null; if (h) h.release(); }
  // Blocks the event loop for good, the way a wedged worker would: no reply, no pong.
  async hang() { for (;;) { /* stuck */ } }
}

process.once('message', (boot) => {
  serveWorker(process, (queue) => new FakeDriver(queue, boot), ['calls', 'whoami', 'think', 'slow', 'hang', 'holdJoins', 'releaseJoins']);
});
process.send({ event: 'boot' });
