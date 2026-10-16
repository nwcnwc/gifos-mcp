// Drives the GifOS Meeting Bot store app in headless Chromium, through the
// app's local control API (window.MeetingBot, contract version 1; see
// CONTROL.md in gifos-apps-source/meeting-bot).
//
// One browser profile under GIFOS_MCP_HOME/profile-bot: a GifOS desktop with
// Meeting Bot and a speech-to-text provider app installed from the GifOS app
// store. Meeting Bot runs in RUN mode in one tab.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { log } from './log.js';
import { AdminRoom } from './admin/room.js';
import { providerRegistration } from './providers/registry.js';
import { mouthInitScript } from './providers/mouth.js';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.control = null;  // second Meeting Bot page, CONTROL mode, admin room
    this.room = null;      // AdminRoom over that page
    this.sttFileId = '';
    this.providers = providerRegistration();
    this.switches = { respond_to_command: true, conversation_voice: 'none' };
    this.earTimer = null;
    this.playGen = 0;
    this.onLine = null;
  }

  ensureStarted() {
    if (this.state === 'ready' && this.bot && this.bot.app && !this.bot.app.isClosed()) return Promise.resolve();
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
    await ctx.addInitScript({ content: mouthInitScript() });
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
    // The store writes the file, then the desktop places its icon (a provider
    // app into Providers). Leaving the page earlier loses the icon.
    let fid = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      fid = await this.installedFileId(desk, slug);
      if (fid && await this.placedParent(desk, fid) !== undefined) return fid;
      await sleep(300);
    }
    throw new Error('Installing ' + slug + ' did not finish.');
  }

  // The parent folder of the app's icon: null for the Home Screen, undefined
  // when no icon exists.
  placedParent(desk, fileId) {
    return desk.evaluate(async (fileId) => {
      const it = (await GifOS.store.allItems()).find((i) => i.fileId === fileId);
      return it ? (it.parent || null) : undefined;
    }, fileId);
  }

  async useAsSpeechToText(desk, fileId, appId) {
    // GifOS only lets a provider answer from the Providers folder.
    if (await this.placedParent(desk, fileId) !== 'sys_providers') {
      throw new Error('The ' + appId + ' app is installed but not in the Providers folder of the bot desktop. Remove ' +
        this.cfg.home + '/profile-bot and restart to reinstall it.');
    }
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
    if (this.cfg.debug) app.on('console', (m) => log('[console] ' + m.text().slice(0, 300)));
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
    await frame.waitForFunction(() => window.MeetingBot && window.MeetingBot.version >= 1, null, { timeout: this.cfg.timeoutMs })
      .catch(() => { throw new Error('This Meeting Bot has no local control API (window.MeetingBot v1). Update Meeting Bot from the GifOS store.'); });
    return { app, frame };
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
    const ctx = await this.launch('profile-bot', audio);
    this.bot = { ctx };
    const desk = await this.desktop(ctx);
    this.bot.desk = desk;
    if (this.cfg.sttApp) {
      this.sttFileId = await this.installFromStore(desk, this.cfg.sttApp);
      await this.useAsSpeechToText(desk, this.sttFileId, this.cfg.sttApp);
    }
    this.bot.fileId = await this.installFromStore(desk, 'meeting-bot');
    await this.shot(desk, 'bot-desktop.png');
    Object.assign(this.bot, await this.openApp(ctx, this.bot.fileId));
    await this.startRun();
    await this.openControl();
    await this.announceProviders();
    await this.armEars();
    await this.shot(this.bot.app, 'bot-running.png');
    this.state = 'ready';
    log('ready: Meeting Bot "' + this.creds.name + '" is running, controlled from its admin room');
  }

  // CONTROL mode of the same signed store app. Commands after boot go
  // through the admin meeting, not through window.MeetingBot on the RUN page.
  async openControl() {
    const opened = await this.openApp(this.bot.ctx, this.bot.fileId);
    this.control = opened;
    const r = await opened.frame.evaluate((c) => window.MeetingBot.start({ mode: 'control', name: c.name, password: c.password })
      .then((s) => ({ ok: true, s }), (e) => ({ ok: false, error: String((e && e.message) || e) })), this.creds);
    if (!r.ok) throw new Error('Meeting Bot control did not start: ' + r.error);
    const t0 = Date.now();
    while (Date.now() - t0 < this.cfg.timeoutMs) {
      const st = await opened.frame.evaluate(() => window.MeetingBot.status());
      if (st.phase === 'control' && st.connected) {
        this.room = new AdminRoom((msg) => this.deliver(msg));
        return st;
      }
      await sleep(300);
    }
    throw new Error('Meeting Bot control never joined its admin meeting.');
  }

  // One controller message in, one bot reply out. The bot password is not
  // part of the message. A room password, when join needs one, is a field
  // the guest already has; it is not the admin password.
  async deliver(msg) {
    const timeout = this.cfg.timeoutMs;
    return await this.control.frame.evaluate(async ({ msg, timeout }) => {
      const list = await gifos.meet.list();
      const admin = (list || []).find((s) => s.control) || (list || [])[0];
      if (!admin || !admin.meetingId) throw new Error('The control session has no admin meeting.');
      let fileText = '';
      const reply = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('The admin room did not answer.')), timeout);
        gifos.meet.onXfer((ev) => {
          try {
            const bytes = ev && ev.bytes ? new Uint8Array(ev.bytes) : new Uint8Array(0);
            fileText = new TextDecoder().decode(bytes);
          } catch (e) { fileText = ''; }
        });
        gifos.meet.onChat((ev) => {
          let decoded = null;
          try { decoded = window.BotProto.decode(String((ev && ev.text) || '')); } catch (e) { decoded = null; }
          if (!decoded || decoded.ref !== msg.id) return;
          clearTimeout(t);
          if (fileText) decoded.fileText = fileText;
          resolve(decoded);
        });
        gifos.meet.sendChat(admin.meetingId, window.BotProto.encode(msg)).catch((e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      return reply;
    }, { msg, timeout });
  }

  async announceProviders() {
    if (!this.room) return { accepted: false };
    try {
      await this.room.call('providers', { roles: this.providers.roles });
      return { accepted: true };
    } catch (e) {
      if (e && e.unknown) return { accepted: false, reason: 'bot-ignored' };
      throw e;
    }
  }

  // RUN first listens ~5 s for a bot with the same name and password. A copy
  // of this server stopped seconds ago can still look alive: wait it out once.
  async startRun() {
    const run = () => this.bot.frame.evaluate((c) => window.MeetingBot.start({ mode: 'run', name: c.name, password: c.password })
      .then((s) => ({ ok: true, s }), (e) => ({ ok: false, error: String((e && e.message) || e) })), this.creds);
    let r = await run();
    if (!r.ok && /already running/.test(r.error)) {
      log('another bot with these credentials looks alive; waiting 20 s and trying once more');
      await sleep(20000);
      r = await run();
    }
    if (!r.ok) throw new Error('Meeting Bot did not start: ' + r.error);
    const t0 = Date.now();
    while (Date.now() - t0 < this.cfg.timeoutMs) {
      const st = await this.bot.frame.evaluate(() => window.MeetingBot.status());
      if (st.phase === 'run' && st.connected) return st;
      await sleep(300);
    }
    throw new Error('Meeting Bot started but never joined its admin meeting.');
  }

  // Calls window.MeetingBot.<method>(...args) in the app frame. A rejection
  // comes back as an Error with the app's own message.
  async call(method, ...args) {
    await this.ensureStarted();
    const r = await this.bot.frame.evaluate(({ method, args }) => window.MeetingBot[method](...args)
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, error: String((e && e.message) || e) })), { method, args });
    if (!r.ok) throw new Error('Meeting Bot: ' + r.error);
    return r.v;
  }

  async join(link, password) {
    await this.ensureStarted();
    const reply = await this.room.call('join', { link, password: password || '' });
    await this.shot(this.bot.app, 'bot-joined.png');
    if (!reply.meetingId) throw new Error('The admin room join did not return a meeting.');
    return reply.meetingId;
  }

  async leave(sessionId) {
    await this.ensureStarted();
    await this.room.call('leave', { meetingId: sessionId });
  }

  async transcribe(sessionId, on) {
    await this.ensureStarted();
    const reply = await this.room.call('transcribe', { meetingId: sessionId, on: !!on });
    const row = (reply.items || []).find((m) => m.id === sessionId);
    if (on && row && row.cc === false) throw new Error('Transcribing did not show on the bot tile.');
  }

  async say(sessionId, text) {
    await this.ensureStarted();
    await this.room.call('say', { meetingId: sessionId, text: String(text) });
  }

  async list() {
    await this.ensureStarted();
    const reply = await this.room.call('list', {});
    return reply.items || reply.meetings || [];
  }

  async transcript(sessionId) {
    await this.ensureStarted();
    const reply = await this.room.call('transcript', { meetingId: sessionId });
    return reply.fileText || '';
  }

  async setSwitches(switches) {
    this.switches = {
      respond_to_command: !!switches.respond_to_command,
      conversation_voice: switches.conversation_voice || 'none',
    };
    if (!this.room) return { accepted: false };
    try {
      await this.room.call('switches', this.switches);
      return { accepted: true };
    } catch (e) {
      if (e && e.unknown) return { accepted: false, reason: 'bot-ignored' };
      throw e;
    }
  }

  async registerProviders(reg) {
    if (reg && reg.roles) this.providers = { v: 1, op: 'providers', roles: reg.roles };
    return this.announceProviders();
  }

  async info() {
    const out = {
      state: this.state, bot_name: this.creds.name, stt_ready: !!this.sttFileId,
      control: this.room ? 'admin-room' : 'starting',
      providers: this.providers.roles,
      switches: this.switches,
    };
    if (this.error) out.error = this.error;
    if (this.state === 'ready') {
      try {
        const st = await this.bot.frame.evaluate(() => window.MeetingBot.status());
        out.connected = !!st.connected;
        if (st.warning) out.warning = st.warning;
        out.bot_sessions = (st.meetings || []).map((m) => ({ session_id: m.id, transcribing: !!m.cc, people: m.people || [] }));
      } catch (e) { out.error = String(e.message || e); }
      // GIFOS_MCP_DEBUG=1: what each meeting page says about its captions.
      if (this.cfg.debug) {
        out.debug_sessions = await this.bot.app.evaluate(() => Array.from(document.querySelectorAll('iframe[data-gifos-meet]')).map((f) => {
          try {
            const g = f.contentWindow.__gifosVideo;
            return { id: f.getAttribute('data-gifos-meet'), captions: g && g.whisperForTest ? g.whisperForTest() : null,
              status: (f.contentDocument.querySelector('#status') || {}).textContent || '' };
          } catch (e) { return { id: f.getAttribute('data-gifos-meet'), error: String(e) }; }
        })).catch((e) => String(e));
      }
    }
    return out;
  }

  // The RUN page hears caption lines. They are kept only for meetings whose
  // tile is transcribing. The admin meeting is not one of those lines.
  async armEars() {
    if (!this.bot || !this.bot.frame) return;
    await this.bot.frame.evaluate(() => {
      if (!window.gifos || !gifos.meet || typeof gifos.meet.onTranscriptLine !== 'function') return;
      if (window.__gifosEar) return;
      window.__gifosEar = true;
      window.__gifosHeard = [];
      gifos.meet.onTranscriptLine((ev) => {
        const line = ev && ev.line;
        if (!line || !ev.meetingId) return;
        window.__gifosHeard.push({
          meetingId: String(ev.meetingId),
          speaker: String(line.by || ''),
          text: String(line.text || ''),
          at: line.at || Date.now(),
        });
      });
    });
    if (this.earTimer) clearInterval(this.earTimer);
    this.earTimer = setInterval(() => {
      this.drainEars().catch((e) => log('ears: ' + (e && e.message || e)));
    }, 500);
    if (this.earTimer.unref) this.earTimer.unref();
  }

  async drainEars() {
    if (!this.bot || !this.bot.frame || typeof this.onLine !== 'function') return;
    const pack = await this.bot.frame.evaluate(() => {
      let cc = [];
      try {
        const st = window.MeetingBot && window.MeetingBot.status ? window.MeetingBot.status() : null;
        cc = ((st && st.meetings) || []).filter((m) => m && m.cc).map((m) => m.id);
      } catch (e) { cc = []; }
      const xs = window.__gifosHeard || [];
      window.__gifosHeard = [];
      return { cc, xs };
    });
    const open = new Set(pack.cc || []);
    for (const line of pack.xs || []) {
      if (!line || !line.text || !open.has(line.meetingId)) continue;
      Promise.resolve(this.onLine(line)).catch((e) => log('converse: ' + (e && e.message || e)));
    }
  }

  async workFrames() {
    if (!this.bot || !this.bot.app) return [];
    const ids = await this.bot.app.evaluate(() => {
      const host = window.GifOS && window.GifOS.meetHost;
      const list = host && host.list ? host.list() : [];
      return list.filter((s) => s && !s.control).map((s) => s.meetingId);
    });
    const frames = [];
    for (const id of ids || []) {
      const el = await this.bot.app.$('iframe[data-gifos-meet="' + id + '"]');
      if (!el) continue;
      const frame = await el.contentFrame();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  // Plays one encoded clip (wav or anything decodeAudioData accepts) into
  // every work meeting. Returns false when the bot is not in one.
  async playEncoded(bytes) {
    if (!bytes || !bytes.length) return false;
    const frames = await this.workFrames().catch(() => []);
    if (!frames.length) return false;
    this.playGen += 1;
    const gen = this.playGen;
    const b64 = Buffer.from(bytes).toString('base64');
    let ok = false;
    for (const frame of frames) {
      const played = await frame.evaluate((audio) => {
        if (typeof window.__gifosPlayEncoded !== 'function') return false;
        return window.__gifosPlayEncoded(audio);
      }, b64).catch(() => false);
      if (played) ok = true;
    }
    if (this.playGen === gen) await this.quiet().catch(() => {});
    return ok;
  }

  async quiet() {
    this.playGen += 1;
    const frames = await this.workFrames().catch(() => []);
    for (const frame of frames) {
      await frame.evaluate(() => {
        if (typeof window.__gifosQuiet === 'function') window.__gifosQuiet();
      }).catch(() => {});
    }
  }

  async close() {
    if (this.earTimer) clearInterval(this.earTimer);
    this.earTimer = null;
    if (this.bot && this.bot.ctx) await this.bot.ctx.close().catch(() => {});
    this.bot = null;
    this.control = null;
    this.room = null;
    this.state = 'stopped';
  }
}
