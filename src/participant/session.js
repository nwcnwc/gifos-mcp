// One Chromium window sitting in a GifOS meeting as a person: a camera card
// and a mic that this process can play into. The page scripts live in page.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { log } from '../log.js';
import { roomFromLink } from '../meetings.js';
import { camInitScript, seedScript, voiceInitScript } from './page.js';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureBrowser(cfg) {
  if (cfg.chrome) return cfg.chrome;
  const exe = chromium.executablePath();
  if (fs.existsSync(exe)) return '';
  if (!cfg.autoInstallBrowser) throw new Error('Chromium for Playwright is missing. Run: npx playwright install chromium');
  log('Chromium is missing; running "playwright install chromium" (one time)…');
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('Could not install Chromium. Run: npx playwright install chromium');
  return '';
}

function applyRelay(url, relay) {
  if (!relay) return url;
  let u;
  try { u = new URL(url); } catch (e) { return url; }
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  if (h.get('relay') || !h.get('v')) return url;
  h.set('relay', relay);
  u.hash = h.toString();
  return u.toString();
}

export class ParticipantSession {
  constructor(cfg, { profile = 'profile-participant' } = {}) {
    this.cfg = cfg;
    this.profile = profile;
    this.ctx = null;
    this.page = null;
    this.onFrame = null;
    // The page polls this while it is speaking, so stop_speaking does not
    // have to wait behind the playback call.
    this.ctrl = null;
  }

  async join({ url, name, password = '', avatarDataUrl = '', vadEndMs = 450 }) {
    const room = roomFromLink(url);
    if (!room) throw new Error('That is not a GifOS meeting link (expected …/run.html#v=<room> or …/meet/<room>).');
    const target = applyRelay(url, this.cfg.relay);
    let parsed;
    try { parsed = new URL(target); } catch (e) { throw new Error('Meeting link is not a URL.'); }
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const av = hash.get('av') || '';
    const exe = ensureBrowser(this.cfg);
    const dir = path.join(this.cfg.home, this.profile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless: this.cfg.headless,
      executablePath: exe || undefined,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone', 'camera'],
      args: [
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        // The meeting page is https. Let it POST PCM to the sidecar on 127.0.0.1.
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
      ],
    });
    // Seed the name before the voice graph, and the voice graph before the
    // camera shim that clones the mic track.
    await this.ctx.addInitScript({ content: seedScript({ name, relay: hash.get('relay') || this.cfg.relay, room, password, av }) });
    await this.ctx.addInitScript({ content: voiceInitScript({ vadEndMs }) });
    await this.ctx.addInitScript({ content: camInitScript({ name, avatarDataUrl }) });
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    if (this.cfg.debug) this.page.on('console', (m) => log('page ' + m.type() + ' ' + m.text().slice(0, 300)));
    await this.page.exposeBinding('__vbFrame', (_source, frame) => {
      try { return (this.onFrame && this.onFrame(frame)) || undefined; }
      catch (e) { return undefined; }
    });
    await this.page.exposeBinding('__vbCtrl', () => {
      try { return { stop: !!(this.ctrl && this.ctrl()) }; }
      catch (e) { return { stop: false }; }
    });
    // The page pulls the next PCM chunk. The handler must not call page.evaluate.
    this.pull = null;
    await this.page.exposeBinding('__vbPull', () => {
      try { return (this.pull && this.pull()) || { done: true }; }
      catch (e) { return { done: true }; }
    });
    log('participant opening ' + target);
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
    const deadline = Date.now() + this.cfg.timeoutMs;
    let seated = null;
    while (Date.now() < deadline) {
      const snap = await this.page.evaluate((pw) => {
        const modal = document.getElementById('pw-modal');
        const open = !!(modal && modal.style.display && modal.style.display !== 'none');
        if (open && pw) {
          const input = document.getElementById('pw-new');
          const btn = document.getElementById('pw-save');
          if (input && !input.value) input.value = pw;
          if (btn) btn.click();
        }
        let coord = null, inMeeting = 0, err = '';
        try {
          const g = window.__gifosVideo;
          const d = g && g.debugDump ? g.debugDump() : null;
          coord = d && d.me ? d.me.coord : null;
          inMeeting = d ? d.inMeeting : 0;
        } catch (e) { err = String(e && e.message || e).slice(0, 160); }
        return { open, coord, inMeeting, err, stats: window.__vbStats || null };
      }, password || '').catch((e) => ({ err: e.message }));
      if (snap && snap.coord) { seated = snap; break; }
      await sleep(400);
    }
    if (!seated) {
      const stats = await this.page.evaluate(() => window.__vbStats || null).catch(() => null);
      throw new Error('Joined the page but no seat appeared. ' + (stats && stats.err ? stats.err : 'The room may be locked, or the relay did not answer.'));
    }
    await this.page.evaluate(() => { try { window.__vbUnmute && window.__vbUnmute(); window.__vbResync && window.__vbResync(); } catch (e) {} }).catch(() => {});
    log('participant seated ' + seated.coord);
    return { url: target, room, coord: seated.coord };
  }

  async play(b64, allowBarge) {
    if (!this.page) throw new Error('Not in a meeting.');
    return await this.page.evaluate(async ({ b64, allowBarge }) => {
      window.__vbAllowBarge = !!allowBarge;
      if (typeof window.__vbPlay !== 'function') throw new Error('voice output is not ready');
      return await window.__vbPlay(b64);
    }, { b64, allowBarge: !!allowBarge });
  }

  // Stream TTS from the local sidecar into the mic. Prefer a fetch the page
  // makes itself. If the https page cannot reach 127.0.0.1, pull chunks
  // through the binding instead. The clock for time-to-first-audio starts
  // inside the page, before the body is read.
  async playRemote(url, body, allowBarge, token) {
    if (!this.page) throw new Error('Not in a meeting.');
    if (this.directVoice == null) {
      this.directVoice = await this.page.evaluate(async ({ url, token }) => {
        try {
          if (typeof window.__vbPlayRemote !== 'function') return false;
          const health = new URL('/health', url).toString();
          const res = await fetch(health, { headers: { authorization: 'Bearer ' + (token || '') } });
          return !!res.ok;
        } catch (e) { return false; }
      }, { url, token: token || '' }).catch(() => false);
    }
    if (this.directVoice) {
      const direct = await this.page.evaluate(async ({ url, body, allowBarge, token }) => {
        window.__vbAllowBarge = !!allowBarge;
        return await window.__vbPlayRemote(url, body, token);
      }, { url, body, allowBarge: !!allowBarge, token: token || '' });
      if (direct && !direct.fetch_error) return direct;
      this.directVoice = false;
    }
    return await this.playPulled(url, body, allowBarge, token);
  }

  async playPulled(url, body, allowBarge, token) {
    let reader = null;
    let rate = 24000;
    let opened = false;
    this.pull = async () => {
      if (this.ctrl && this.ctrl()) {
        if (reader) { try { await reader.cancel(); } catch (e) {} }
        return { stop: true };
      }
      if (!opened) {
        opened = true;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token || '') },
          body: JSON.stringify(body || {}),
        });
        if (!res.ok || !res.body) return { done: true, error: 'tts ' + res.status };
        rate = Number(res.headers.get('x-audio-rate') || 24000);
        reader = res.body.getReader();
      }
      const chunk = await reader.read();
      if (chunk.done) return { done: true, rate };
      return { b64: Buffer.from(chunk.value).toString('base64'), rate, done: false };
    };
    try {
      return await this.page.evaluate(async (allowBarge) => {
        window.__vbAllowBarge = !!allowBarge;
        if (typeof window.__vbPlayPull !== 'function') throw new Error('voice output is not ready');
        return await window.__vbPlayPull();
      }, !!allowBarge);
    } finally {
      this.pull = null;
      if (reader) { try { await reader.cancel(); } catch (e) {} }
    }
  }

  async screenshot(dest) {
    if (!this.page) throw new Error('Not in a meeting.');
    await this.page.screenshot({ path: dest, type: 'png' });
  }

  async stop() {
    if (!this.page) return;
    await this.page.evaluate(() => { try { window.__vbStop && window.__vbStop(); } catch (e) {} });
  }

  async chat(text) {
    if (!this.page) throw new Error('Not in a meeting.');
    return await this.page.evaluate((t) => {
      const g = window.__gifosVideo;
      if (g && g.sayForTest) return g.sayForTest(t);
      const input = document.getElementById('chat-in');
      const form = document.getElementById('chatform');
      if (!input || !form) throw new Error('chat is not available on this page');
      input.value = t;
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }, text);
  }

  async setHand(on) {
    if (!this.page) throw new Error('Not in a meeting.');
    await this.page.evaluate((on) => {
      const g = window.__gifosVideo;
      if (g && g.raiseHand) { g.raiseHand(!!on); return; }
      const btn = document.getElementById('hand');
      if (!btn) throw new Error('hand control is not on the page');
      const raised = btn.classList.contains('off');
      if (raised !== !!on) btn.click();
    }, !!on);
  }

  async setMic(on) {
    await this.setToggle('mic', !!on);
  }

  async setCam(on) {
    await this.setToggle('cam', !!on);
  }

  async setToggle(id, on) {
    if (!this.page) throw new Error('Not in a meeting.');
    await this.page.evaluate(({ id, on }) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(id + ' control is not on the page');
      const isOn = !el.classList.contains('off');
      if (isOn !== on) el.click();
    }, { id, on });
  }

  async state() {
    if (!this.page) throw new Error('Not in a meeting.');
    return await this.page.evaluate(() => {
      const g = window.__gifosVideo || {};
      let dump = null;
      try { dump = g.debugDump ? g.debugDump() : null; } catch (e) {}
      const names = [];
      const tiles = document.querySelectorAll('.tile[data-peer]');
      for (let i = 0; i < tiles.length; i++) {
        const n = tiles[i].querySelector('.name');
        const t = n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (t) names.push(t);
      }
      const mic = document.getElementById('mic');
      const cam = document.getElementById('cam');
      return {
        participants: names,
        inMeeting: dump ? dump.inMeeting : names.length,
        me: dump && dump.me ? { name: dump.me.name || '', coord: dump.me.coord || null } : null,
        hand: g.handRaised ? !!g.handRaised() : false,
        mic: mic ? !mic.classList.contains('off') : false,
        cam: cam ? !cam.classList.contains('off') : false,
        playing: !!window.__vbPlaying,
        stats: window.__vbStats || null,
        chat: g.chatTexts ? g.chatTexts() : [],
      };
    });
  }

  async stats() {
    if (!this.page) return null;
    return await this.page.evaluate(() => window.__vbStats || null);
  }

  async leave() {
    if (!this.page) return;
    await this.page.evaluate(() => {
      try { const g = window.__gifosVideo; if (g && g.leaveForTest) g.leaveForTest(); } catch (e) {}
    }).catch(() => {});
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}
