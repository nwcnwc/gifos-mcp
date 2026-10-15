// Drives the GifOS Meeting Bot store app in headless Chromium.
//
// Two browser profiles under GIFOS_MCP_HOME:
//   profile-bot      GifOS desktop with Meeting Bot (and an STT provider app)
//                    installed from the GifOS app store, running in RUN mode.
//   profile-control  The same Meeting Bot app in CONTROL mode, with the same
//                    name and password. This server talks to the bot through
//                    it, using the app's own protocol (structured chat in the
//                    secret admin meeting), exactly like a person would from
//                    another device.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { log } from './log.js';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the CONTROL app's sandboxed frame. It only uses what the app
// itself has: the gifos.meet API and the app's BotProto codec.
const CONTROLLER_SHIM = `(() => {
  if (window.__gifosMcp) return true;
  var replies = {}, xfers = {}, beat = null;
  gifos.meet.onChat(function (ev) {
    var m = BotProto.decode(String((ev && ev.text) || ''));
    if (!m || m.role !== 'bot') return;
    if (m.op === 'beat') beat = { at: Date.now(), instance: m.instance || '', meetings: m.meetings || [] };
    if (m.ref) replies[m.ref] = m;
  });
  gifos.meet.onXfer(function (ev) {
    if (!ev || !ev.id) return;
    var text = '';
    try { text = new TextDecoder().decode(new Uint8Array(ev.bytes || new ArrayBuffer(0))); } catch (e) {}
    xfers[ev.id] = { name: ev.name || '', mime: ev.mime || '', text: text };
  });
  function adminId() {
    return gifos.meet.list().then(function (l) {
      var c = (l || []).filter(function (s) { return s.control; })[0];
      if (!c) throw new Error('The control window is not in the admin meeting.');
      return c.meetingId;
    });
  }
  window.__gifosMcp = {
    send: function (msg) {
      var id = 'mcp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return adminId().then(function (aid) {
        var body = Object.assign({ v: 1, role: 'controller', instance: 'gifos-mcp' }, msg, { id: id });
        return gifos.meet.sendChat(aid, BotProto.encode(body));
      }).then(function () { return id; });
    },
    reply: function (id) { return replies[id] || null; },
    xfer: function (id) { var x = xfers[id] || null; if (x) delete xfers[id]; return x; },
    beat: function () { return beat ? { age: Date.now() - beat.at, instance: beat.instance, meetings: beat.meetings } : null; }
  };
  return true;
})()`;

// A short silent WAV for the bot's fake microphone, so the bot never opens
// the real microphone of the machine it runs on.
function silenceWav(file) {
  const rate = 16000, n = rate * 2;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, Buffer.alloc(n * 2)]));
}

export class MeetingBotDriver {
  constructor(cfg, creds) {
    this.cfg = cfg;
    this.creds = creds;
    this.state = 'stopped';
    this.error = '';
    this.starting = null;
    this.bot = null;      // { ctx, desk, app, frame, fileId }
    this.ctrl = null;     // { ctx, desk, app, frame, fileId }
    this.sttFileId = '';
  }

  ensureStarted() {
    if (this.state === 'ready' && this.ctrl && !this.ctrl.app.isClosed() && this.bot && !this.bot.app.isClosed()) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().then(() => { this.starting = null; }, async (e) => {
        this.starting = null;
        this.state = 'error';
        this.error = String((e && e.message) || e);
        log('start failed: ' + this.error);
        await this.close().catch(() => {});
        this.state = 'error';
        throw e;
      });
    }
    return this.starting;
  }

  ensureBrowserBinary() {
    if (this.cfg.chrome) return this.cfg.chrome;
    const exe = chromium.executablePath();
    if (fs.existsSync(exe)) return '';
    if (!this.cfg.autoInstallBrowser) throw new Error('Chromium for Playwright is missing. Run: npx playwright install chromium');
    log('Chromium is missing; running "playwright install chromium" (one time, about 150 MB)…');
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
    if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('Could not install Chromium. Run: npx playwright install chromium');
    return '';
  }

  async launch(profile, audioFile) {
    const exe = this.ensureBrowserBinary();
    const ctx = await chromium.launchPersistentContext(path.join(this.cfg.home, profile), {
      headless: this.cfg.headless,
      executablePath: exe || undefined,
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone'],
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--use-file-for-fake-audio-capture=' + audioFile,
        '--autoplay-policy=no-user-gesture-required',
        // Meetings live in background tabs; keep their timers running.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const init = { gifos_meet_bar: '0', gifos_name: this.creds.name };
    if (this.cfg.relay) init.gifos_relay = this.cfg.relay;
    await ctx.addInitScript({ content: 'try{var o=' + JSON.stringify(init) + ';for(var k in o)localStorage.setItem(k,o[k]);}catch(e){}' });
    return ctx;
  }

  async desktop(ctx) {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(this.cfg.gifosUrl + '/index.html', { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    await page.waitForFunction(() => window.GifOS && GifOS.store && GifOS.store.allFiles, null, { timeout: this.cfg.timeoutMs });
    await page.waitForSelector('.icon', { timeout: this.cfg.timeoutMs });
    return page;
  }

  installedFileId(desk, appId) {
    return desk.evaluate(async (appId) => {
      const files = await GifOS.store.allFiles();
      const f = files.find((x) => x.isApp && x.appId === appId);
      return f ? f.id : '';
    }, appId);
  }

  // Installs (or updates) an app through the GifOS store page, the same
  // clicks a person makes. Returns the installed fileId.
  async installFromStore(desk, slug) {
    const have = await this.installedFileId(desk, slug);
    await desk.goto(this.cfg.gifosUrl + '/store.html#app=' + encodeURIComponent(slug), { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    const button = desk.locator('#install, #update').first();
    try {
      await button.waitFor({ timeout: 30000 });
    } catch (e) {
      if (have) { log('store page for ' + slug + ' did not load; keeping the installed copy'); return have; }
      throw new Error('The GifOS store at ' + this.cfg.gifosUrl + ' has no "' + slug + '" app (or the store did not load).');
    }
    const id = await button.getAttribute('id');
    const disabled = await button.isDisabled();
    if (disabled) {
      if (have) return have;
      throw new Error('The store refused to install ' + slug + ': ' + (await button.innerText()));
    }
    if (have && id === 'install') return have; // installed and current ("Install again")
    log((have ? 'updating ' : 'installing ') + slug + ' from the GifOS store');
    await button.click();
    if (have) {
      await desk.waitForFunction(() => !document.querySelector('#update'), null, { timeout: this.cfg.timeoutMs }).catch(() => {});
      return have;
    }
    await desk.waitForURL(/index\.html/, { timeout: this.cfg.timeoutMs });
    await desk.waitForSelector('.icon', { timeout: this.cfg.timeoutMs });
    let fid = '';
    const t0 = Date.now();
    while (!fid && Date.now() - t0 < 30000) { fid = await this.installedFileId(desk, slug); if (!fid) await sleep(300); }
    if (!fid) throw new Error('Installing ' + slug + ' did not finish.');
    return fid;
  }

  async useAsSpeechToText(desk, fileId, appId) {
    await desk.evaluate(({ fileId, appId }) => {
      const cfg = JSON.parse(localStorage.getItem('gifos_ai_config') || '{}') || {};
      if (cfg.stt && cfg.stt.app === fileId) return;
      cfg.stt = { app: fileId, appId, appName: appId };
      localStorage.setItem('gifos_ai_config', JSON.stringify(cfg));
    }, { fileId, appId });
  }

  async openApp(ctx, fileId) {
    const app = await ctx.newPage();
    app.on('pageerror', (e) => log('[app] ' + e.message));
    await app.goto(this.cfg.gifosUrl + '/run.html#id=' + encodeURIComponent(fileId), { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    await app.waitForSelector('#appmount iframe', { timeout: this.cfg.timeoutMs });
    // First launch asks for the app's abilities. Meeting Bot needs Meet and Remote.
    const sheet = app.locator('.perm-box');
    if (await sheet.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      for (const cap of ['meet', 'remote']) {
        const box = sheet.locator('input[data-cap="' + cap + '"]');
        if (await box.count()) await box.check();
      }
      await sheet.locator('.done').click();
      await sheet.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    }
    const frame = await (await app.$('#appmount iframe')).contentFrame();
    await frame.waitForSelector('#start', { timeout: this.cfg.timeoutMs });
    return { app, frame };
  }

  async startMode(frame, mode) {
    await frame.check(mode === 'run' ? '#mode-run' : '#mode-control');
    await frame.fill('#bot-name', this.creds.name);
    await frame.fill('#bot-pass', this.creds.password);
    if (mode === 'run') await frame.fill('#rules', '');
    await frame.click('#start');
    const want = mode === 'run' ? 'Running' : 'Controlling';
    const t0 = Date.now();
    while (Date.now() - t0 < this.cfg.timeoutMs) {
      const phase = (await frame.textContent('#phase')) || '';
      if (phase === want) return;
      const warn = await frame.$eval('#warn', (el) => (el.classList.contains('show') ? el.textContent : '')).catch(() => '');
      if (warn && phase !== 'Checking whether this bot is already running…') throw new Error('Meeting Bot (' + mode + '): ' + warn);
      await sleep(500);
    }
    throw new Error('Meeting Bot did not reach ' + want + ' in time.');
  }

  async shot(page, name) {
    if (!this.cfg.shotsDir || !page) return;
    try {
      fs.mkdirSync(this.cfg.shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(this.cfg.shotsDir, name) });
    } catch (e) { log('screenshot ' + name + ': ' + e.message); }
  }

  async start() {
    this.state = 'starting';
    this.error = '';
    fs.mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    let audio = this.cfg.botAudio;
    if (!audio) { audio = path.join(this.cfg.home, 'silence.wav'); if (!fs.existsSync(audio)) silenceWav(audio); }

    log('starting the bot browser for ' + this.cfg.gifosUrl);
    const botCtx = await this.launch('profile-bot', audio);
    this.bot = { ctx: botCtx };
    const desk = await this.desktop(botCtx);
    this.bot.desk = desk;
    if (this.cfg.sttApp) {
      this.sttFileId = await this.installFromStore(desk, this.cfg.sttApp);
      await this.useAsSpeechToText(desk, this.sttFileId, this.cfg.sttApp);
    }
    this.bot.fileId = await this.installFromStore(desk, 'meeting-bot');
    await this.shot(desk, 'bot-desktop.png');
    Object.assign(this.bot, await this.openApp(botCtx, this.bot.fileId));
    await this.startRun();
    await this.shot(this.bot.app, 'bot-running.png');

    log('starting the control browser');
    const ctrlCtx = await this.launch('profile-control', audio);
    this.ctrl = { ctx: ctrlCtx };
    const cdesk = await this.desktop(ctrlCtx);
    this.ctrl.desk = cdesk;
    this.ctrl.fileId = await this.installFromStore(cdesk, 'meeting-bot');
    Object.assign(this.ctrl, await this.openApp(ctrlCtx, this.ctrl.fileId));
    await this.startMode(this.ctrl.frame, 'control');
    await this.ctrl.frame.evaluate(CONTROLLER_SHIM);
    await this.waitForBeat(this.cfg.timeoutMs);
    await this.shot(this.ctrl.app, 'control.png');
    this.state = 'ready';
    log('ready: Meeting Bot is running and answering');
  }

  // The bot announces itself every 3 s. A recent copy of a stopped bot (a
  // restart within seconds) can still be in the admin meeting: wait it out
  // once, then report it.
  async startRun() {
    try {
      await this.startMode(this.bot.frame, 'run');
    } catch (e) {
      if (!/already running/.test(String(e.message))) throw e;
      log('another bot with these credentials looks alive; waiting 20 s and trying once more');
      await sleep(20000);
      await this.startMode(this.bot.frame, 'run');
    }
  }

  async waitForBeat(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const b = await this.ctrl.frame.evaluate(() => window.__gifosMcp.beat());
      if (b && b.age < 10000) return b;
      await sleep(500);
    }
    throw new Error('The control window never heard the bot in the admin meeting.');
  }

  async command(msg, { timeoutMs } = {}) {
    await this.ensureStarted();
    const f = this.ctrl.frame;
    const id = await f.evaluate((m) => window.__gifosMcp.send(m), msg);
    const limit = timeoutMs || this.cfg.timeoutMs;
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      const r = await f.evaluate((id) => window.__gifosMcp.reply(id), id);
      if (r) {
        if (r.op === 'err') throw new Error('Meeting Bot: ' + (r.text || 'error'));
        return r;
      }
      await sleep(250);
    }
    throw new Error('Meeting Bot did not answer "' + msg.op + '" in ' + Math.round(limit / 1000) + ' s.');
  }

  async join(link, password) {
    const r = await this.command({ op: 'join', link, password: password || '' });
    const m = /joined (\S+)/.exec(r.text || '');
    if (!m) throw new Error('Meeting Bot answered the join without a session id: ' + (r.text || ''));
    await this.shot(this.bot.app, 'bot-joined.png');
    return m[1];
  }

  async leave(sessionId) { await this.command({ op: 'leave', meetingId: sessionId }); }
  async transcribe(sessionId, on) { await this.command({ op: 'transcribe', meetingId: sessionId, on: !!on }); }
  async say(sessionId, text) { await this.command({ op: 'say', meetingId: sessionId, text: String(text) }); }

  async list() {
    const r = await this.command({ op: 'list' });
    return r.items || [];
  }

  async transcript(sessionId) {
    const r = await this.command({ op: 'transcript', meetingId: sessionId });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const x = await this.ctrl.frame.evaluate((id) => window.__gifosMcp.xfer(id), r.xferId);
      if (x) return x.text;
      await sleep(250);
    }
    throw new Error('The transcript download did not arrive.');
  }

  async info() {
    const out = { state: this.state, bot_name: this.creds.name, stt_ready: !!this.sttFileId };
    if (this.error) out.error = this.error;
    if (this.state === 'ready') {
      try {
        const b = await this.ctrl.frame.evaluate(() => window.__gifosMcp.beat());
        out.last_heartbeat_ms = b ? b.age : null;
        out.bot_sessions = b ? b.meetings.map((m) => ({ session_id: m.id, transcribing: !!m.cc })) : [];
      } catch (e) { out.error = String(e.message || e); }
    }
    return out;
  }

  async close() {
    for (const side of [this.ctrl, this.bot]) {
      if (side && side.ctx) await side.ctx.close().catch(() => {});
    }
    this.ctrl = null;
    this.bot = null;
    this.state = 'stopped';
  }
}
