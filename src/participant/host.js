// The participant body: one meeting, per-speaker transcripts, and a mouth.
// The browser session is swappable so unit tests never launch Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { roomFromLink } from '../meetings.js';
import { createVad, isHallucination, rms, turnHint } from '../audio/vad.js';
import { f32FromI16, i16FromB64, wavFromPcm } from '../audio/wav.js';
import { requestBuf } from '../audio/net.js';
import { sharedVoice } from '../voice/client.js';
import { isSelfName, withAiBadge } from './names.js';
import { ParticipantSession } from './session.js';
import { readTranscript, TranscriptLog } from './transcript.js';

const DISCLOSE_CHAT = "I'm an AI assistant. I transcribe speech in this meeting so I can take part, and I'm telling you that here. I am not recording. I'll leave if you ask.";
const DISCLOSE_SAY = "I'm an AI assistant. I transcribe what I hear so I can take part, and I am not recording.";

const AVATAR_MAX = 4 * 1024 * 1024;

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function loadAvatar(avatar) {
  if (!avatar) return '';
  const s = String(avatar).trim();
  if (!s) return '';
  if (s.startsWith('data:image/')) {
    if (s.length > AVATAR_MAX * 1.4) throw new Error('avatar is larger than 4 MB');
    return s;
  }
  if (/^https?:\/\//.test(s)) {
    const res = await requestBuf(s, { timeout: 20000 });
    if (res.status >= 300) throw new Error('avatar download failed (' + res.status + ')');
    if (res.body.length > AVATAR_MAX) throw new Error('avatar is larger than 4 MB');
    const ct = String(res.headers['content-type'] || 'image/png').split(';')[0].trim() || 'image/png';
    if (!ct.startsWith('image/')) throw new Error('avatar URL was not an image');
    return 'data:' + ct + ';base64,' + res.body.toString('base64');
  }
  if (!fs.existsSync(s)) throw new Error('avatar file not found');
  const buf = fs.readFileSync(s);
  if (buf.length > AVATAR_MAX) throw new Error('avatar is larger than 4 MB');
  return 'data:' + mimeFor(s) + ';base64,' + buf.toString('base64');
}

export class ParticipantHost {
  constructor(cfg, meetings, sessionFactory, deps = {}) {
    this.cfg = cfg;
    this.meetings = meetings;
    this.sessionFactory = sessionFactory || ((cfg) => new ParticipantSession(cfg));
    // Injected engines keep unit tests off the sidecar. Production uses the sidecar.
    this.injected = !!(deps.stt || deps.tts);
    this.makeStt = deps.stt || null;
    this.makeTts = deps.tts || null;
    this.session = null;
    this.meetingId = null;
    this.displayName = '';
    this.vads = new Map();
    this.heard = [];
    this.nextId = 1;
    this.speakingNow = new Map();
    this.lastSpeechEnd = 0;
    this.selfSpeaking = false;
    this.selfSpeakEnd = 0;
    this.pending = 0;
    this.waiters = [];
    this.stt = null;
    this.tts = null;
    this.disclosed = false;
    this.spoken = false;
    this.seen = new Set();
    this.stopRequested = false;
    this.speakChain = Promise.resolve();
    this.gen = 0;
    this.announceTimer = null;
    this.voice = null;
    this.transcript = null;
    this.onTranscript = null;
    this.sttQueues = new Map();
    this.quietMs = new Map();
  }

  async ensureVoice() {
    if (this.injected) {
      if (!this.stt && this.makeStt) this.stt = this.makeStt(this.cfg);
      if (!this.tts && this.makeTts) this.tts = this.makeTts(this.cfg);
      return;
    }
    if (!this.voice) {
      this.voice = await sharedVoice(this.cfg);
      this.stt = this.voice;
      this.tts = this.voice;
    }
  }

  appendLine(fields) {
    if (!this.transcript || !this.meetingId) return null;
    const entry = this.transcript.append(fields);
    if (typeof this.onTranscript === 'function') {
      try { this.onTranscript({ ...entry, meeting_id: this.meetingId }); }
      catch (e) { log('transcript notify: ' + (e && e.message || e)); }
    }
    return entry;
  }

  readTranscript(id) {
    return readTranscript(this.cfg.home, id);
  }

  need() {
    if (!this.session) throw new Error('Not in a meeting. Call join_meeting_as_participant first.');
    return this.session;
  }

  async join({ url, password, display_name, avatar }) {
    const link = String(url || '').trim();
    if (!roomFromLink(link)) throw new Error('That is not a GifOS meeting link (expected …/run.html#v=<room> or …/meet/<room>).');
    if (this.session) await this.leave();
    await this.ensureVoice();
    const gen = ++this.gen;
    const name = withAiBadge(display_name);
    this.displayName = name;
    this.disclosed = false;
    this.spoken = false;
    this.seen = new Set();
    this.heard = [];
    this.vads = new Map();
    this.speakingNow = new Map();
    this.lastSpeechEnd = Date.now();
    this.selfSpeakEnd = 0;
    this.pending = 0;
    const avatarDataUrl = await loadAvatar(avatar);
    const session = this.sessionFactory(this.cfg);
    session.onFrame = (frame) => this.onFrame(frame);
    session.ctrl = () => this.stopRequested;
    this.session = session;
    try {
      await session.join({
        url: link,
        name,
        password: password || '',
        avatarDataUrl,
        vadEndMs: this.cfg.vadEndMs || 450,
      });
    } catch (e) {
      await session.close().catch(() => {});
      if (this.session === session) this.session = null;
      throw e;
    }
    const m = this.meetings.add({
      topic: name,
      room: roomFromLink(link),
      link,
      state: 'live',
      mode: 'participant',
      display_name: name,
      started_at: new Date().toISOString(),
    });
    this.meetingId = m.meeting_id;
    this.transcript = new TranscriptLog(this.cfg.home, m.meeting_id);
    this.appendLine({ kind: 'event', speaker: name, text: 'joined', ts: Date.now() });
    this.watchRoom(gen);
    log('participant ' + name + ' in ' + m.meeting_id);
    return { meeting_id: m.meeting_id, display_name: name, link };
  }

  // Chat the disclosure again for each new person. Speak it once, when the
  // first other person can actually hear it (a line sent before they connect
  // never reaches them).
  watchRoom(gen) {
    const step = async () => {
      if (gen !== this.gen || !this.session) return;
      try {
        const st = await this.session.state();
        const others = (st.participants || []).filter((n) => n && !/\(you\)\s*$/.test(n) && !isSelfName(n, this.displayName));
        let fresh = false;
        for (const n of others) {
          if (!this.seen.has(n)) { this.seen.add(n); fresh = true; }
        }
        if (fresh) {
          await this.session.chat(DISCLOSE_CHAT);
          this.appendLine({ kind: 'chat', speaker: this.displayName, text: DISCLOSE_CHAT, ts: Date.now() });
          log('participant disclosed in chat to ' + others.length);
        }
        if (!this.spoken && others.length) {
          this.spoken = true;
          try { await this.say(DISCLOSE_SAY, '', true); }
          finally { this.disclosed = true; }
          log('participant disclosed by voice');
        }
      } catch (e) {
        if (gen === this.gen) log('participant announce: ' + (e && e.message || e));
      }
      if (gen === this.gen && this.session && !this.disclosed) this.armAnnounce(step, 1000);
    };
    this.armAnnounce(step, 600);
  }

  armAnnounce(step, ms) {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(step, ms);
    // The MCP process stays up on its own. A timer must not keep unit tests alive.
    if (this.announceTimer.unref) this.announceTimer.unref();
  }

  onFrame(frame) {
    try {
      if (!frame || !frame.b64) return this.stopRequested ? { stop: true } : undefined;
      const name = String(frame.name || '').trim();
      if (/\(you\)\s*$/.test(name) || isSelfName(name, this.displayName)) {
        return this.stopRequested ? { stop: true } : undefined;
      }
      const i16 = i16FromB64(frame.b64);
      if (!i16.length) return this.stopRequested ? { stop: true } : undefined;
      const id = String(frame.streamId || name || 'remote');
      let slot = this.vads.get(id);
      if (!slot) {
        slot = { vad: createVad({ vadEndMs: this.cfg.vadEndMs || 450 }), name: name || 'speaker' };
        this.vads.set(id, slot);
      }
      if (name && name !== 'speaker' && name !== '…') slot.name = name;
      const now = Date.now();
      if (this.voice) {
        const energy = rms(f32FromI16(i16));
        const speaker = (name && name !== '…') ? name : (slot.name || 'speaker');
        if (name && name !== 'speaker' && name !== '…') slot.name = name;
        if (energy > 0.006) {
          this.speakingNow.set(speaker, now);
          this.quietMs.set(id, 0);
        } else {
          const quiet = (this.quietMs.get(id) || 0) + (i16.length / 16);
          this.quietMs.set(id, quiet);
          if (quiet > 800) this.speakingNow.delete(speaker);
        }
        this.enqueuePcm(id, slot.name || speaker, i16);
        this.poke();
        return this.stopRequested ? { stop: true } : undefined;
      }
      const r = slot.vad.feed(f32FromI16(i16), i16, now);
      if (r.speaking) this.speakingNow.set(slot.name, now);
      else this.speakingNow.delete(slot.name);
      if (r.utterance && !isSelfName(slot.name, this.displayName)) {
        this.pending++;
        const speaker = slot.name;
        const utter = r.utterance;
        this.transcribe(speaker, utter).catch((e) => log('stt failed: ' + (e && e.message || e)));
      }
      this.poke();
    } catch (e) {
      log('participant frame: ' + (e && e.message || e));
    }
    return this.stopRequested ? { stop: true } : undefined;
  }

  async transcribe(speaker, utter) {
    try {
      if (!this.stt) this.stt = this.makeStt(this.cfg);
      const wav = wavFromPcm(utter.pcm, 16000, 1);
      const out = await this.stt.transcribe(wav);
      const text = String(out.text || '').trim();
      if (!text || isHallucination(text) || isSelfName(speaker, this.displayName)) {
        log('stt drop ' + speaker + ' ' + (out.ms || 0) + 'ms');
        return;
      }
      const entry = {
        id: 'u' + (this.nextId++),
        speaker,
        text,
        t_start: utter.tStart,
        t_end: utter.tEnd,
      };
      this.heard.push(entry);
      if (this.heard.length > 400) this.heard.splice(0, this.heard.length - 400);
      this.lastSpeechEnd = Math.max(this.lastSpeechEnd, utter.tEnd);
      this.appendLine({ kind: 'speech', speaker, text, ts: utter.tEnd });
      log('stt ' + speaker + ' ' + (out.ms || 0) + 'ms ' + text.length + ' chars');
    } finally {
      this.pending = Math.max(0, this.pending - 1);
      this.poke();
    }
  }

  enqueuePcm(streamId, speaker, i16) {
    const prev = this.sttQueues.get(streamId) || Promise.resolve();
    this.pending++;
    const run = prev.then(async () => {
      if (!this.voice) return;
      const events = await this.voice.pushPcm(streamId, speaker, i16);
      for (const ev of events || []) this.applyStt(speaker, ev);
    }).catch((e) => log('stt failed: ' + (e && e.message || e))).finally(() => {
      this.pending = Math.max(0, this.pending - 1);
      this.poke();
    });
    this.sttQueues.set(streamId, run.then(() => {}, () => {}));
  }

  applyStt(speaker, ev) {
    if (!ev || !ev.final) return;
    const text = String(ev.text || '').trim();
    if (!text || isHallucination(text) || isSelfName(speaker, this.displayName)) {
      log('stt drop ' + speaker);
      return;
    }
    const tStart = Number(ev.t_start) || Date.now();
    const tEnd = Math.max(tStart, Number(ev.t_end) || Date.now());
    const entry = { id: 'u' + (this.nextId++), speaker, text, t_start: tStart, t_end: tEnd };
    this.heard.push(entry);
    if (this.heard.length > 400) this.heard.splice(0, this.heard.length - 400);
    this.lastSpeechEnd = Math.max(this.lastSpeechEnd, tEnd);
    this.appendLine({ kind: 'speech', speaker, text, ts: tEnd });
    log('stt ' + speaker + ' ' + text.length + ' chars');
  }

  pick(since) {
    if (since == null || since === '') return this.heard.slice();
    const s = typeof since === 'number' ? String(since) : String(since);
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return this.heard.filter((u) => u.t_end > n);
    }
    const i = this.heard.findIndex((u) => u.id === s);
    if (i < 0) return this.heard.slice();
    return this.heard.slice(i + 1);
  }

  stateSnapshot() {
    const now = Date.now();
    for (const [n, t] of this.speakingNow) if (now - t > 800) this.speakingNow.delete(n);
    const speaking = [...this.speakingNow.keys()];
    const last = Math.max(this.lastSpeechEnd || 0, this.selfSpeaking ? now : (this.selfSpeakEnd || 0));
    const silence = (speaking.length || this.selfSpeaking) ? 0 : Math.max(0, now - (last || now));
    return {
      speaking_now: speaking,
      last_speech_end_ms: last || 0,
      silence_ms: silence,
      turn_hint: turnHint({
        speakingNow: speaking,
        selfSpeaking: this.selfSpeaking,
        pending: this.pending > 0,
        silenceMs: silence,
        pauseMs: this.cfg.turnPauseMs == null ? 700 : this.cfg.turnPauseMs,
      }),
    };
  }

  poke() {
    const list = this.waiters.slice();
    for (const fn of list) { try { fn(); } catch (e) {} }
  }

  utterances({ since, wait_ms } = {}) {
    this.need();
    const wait = Math.max(0, Math.min(30000, Number(wait_ms) || 0));
    const ready = () => this.pick(since);
    if (ready().length || wait <= 0) return Promise.resolve({ utterances: ready(), state: this.stateSnapshot() });
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.waiters.indexOf(check);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve({ utterances: ready(), state: this.stateSnapshot() });
      };
      const check = () => { if (ready().length) finish(); };
      const timer = setTimeout(finish, wait);
      this.waiters.push(check);
    });
  }

  say(text, voice, interruptible = true) {
    this.need();
    const run = this.speakChain.then(() => this.sayNow(text, voice, interruptible !== false));
    this.speakChain = run.then(() => {}, () => {});
    return run;
  }

  async sayNow(text, voice, interruptible) {
    const session = this.need();
    await this.ensureVoice();
    this.stopRequested = false;
    this.selfSpeaking = true;
    this.poke();
    let result;
    try {
      if (this.voice && typeof session.playRemote === 'function') {
        result = await session.playRemote(this.voice.ttsUrl(), { text: String(text), voice: voice || '' }, interruptible, this.voice.token);
      } else {
        if (!this.tts) throw new Error('text to speech is not available');
        const wav = await this.tts.synthesize(String(text), voice || '');
        if (!wav || !wav.length) throw new Error('text to speech returned no audio');
        if (this.stopRequested || !this.session) {
          return { interrupted: true, spoken_until_ms: 0, ttfa_ms: 0, text: String(text) };
        }
        result = await session.play(Buffer.from(wav).toString('base64'), interruptible);
      }
    } finally {
      this.selfSpeaking = false;
      this.selfSpeakEnd = Date.now();
      this.lastSpeechEnd = Math.max(this.lastSpeechEnd, this.selfSpeakEnd);
      this.stopRequested = false;
      this.poke();
    }
    const spoken = result && Number(result.spoken_ms) || 0;
    const interrupted = !!(result && result.interrupted);
    const ttfa = result && Number(result.ttfa_ms);
    this.appendLine({ kind: 'bot', speaker: this.displayName, text: String(text), ts: Date.now() });
    log('say ' + (interrupted ? 'interrupted ' : '') + spoken + 'ms' + (Number.isFinite(ttfa) ? ' ttfa ' + ttfa + 'ms' : '') + ' ' + String(text).length + ' chars');
    const out = { interrupted, spoken_until_ms: spoken, text: String(text) };
    if (Number.isFinite(ttfa)) out.ttfa_ms = ttfa;
    return out;
  }

  async stop() {
    this.stopRequested = true;
    this.poke();
    if (this.session) this.session.stop().catch(() => {});
    return { stopped: true };
  }

  async chat(text) {
    await this.need().chat(String(text));
    this.appendLine({ kind: 'chat', speaker: this.displayName, text: String(text), ts: Date.now() });
    return { sent: true };
  }

  async hand(on) {
    await this.need().setHand(!!on);
    return { hand_raised: !!on };
  }

  async mic(on) {
    await this.need().setMic(!!on);
    return { mic_on: !!on };
  }

  async cam(on) {
    await this.need().setCam(!!on);
    return { camera_on: !!on };
  }

  async snapshot() {
    const state = await this.meetingState();
    let rel = null;
    if (this.session && typeof this.session.screenshot === 'function' && this.transcript) {
      const dir = path.join(this.transcript.dir, 'snapshots');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = 'snap-' + Date.now() + '.png';
      await this.session.screenshot(path.join(dir, name));
      rel = 'snapshots/' + name;
    }
    const line = this.appendLine({ kind: 'snapshot', speaker: this.displayName, text: rel || 'snapshot', ts: Date.now() });
    return {
      ...state,
      snapshot: rel,
      recent: this.transcript ? this.transcript.recent(12) : [],
      transcript_seq: line ? line.seq : null,
    };
  }

  async meetingState() {
    const page = await this.need().state();
    const snap = this.stateSnapshot();
    return {
      meeting_id: this.meetingId,
      display_name: this.displayName,
      participants: page.participants,
      speaking_now: snap.speaking_now,
      hand_raised: page.hand,
      mic_on: page.mic,
      camera_on: page.cam,
      self_speaking: this.selfSpeaking,
      disclosed: this.disclosed,
      turn_hint: snap.turn_hint,
    };
  }

  async leave() {
    const id = this.meetingId;
    if (this.transcript && id) this.appendLine({ kind: 'event', speaker: this.displayName, text: 'left', ts: Date.now() });
    this.transcript = null;
    this.gen++;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    const session = this.session;
    this.session = null;
    this.meetingId = null;
    this.selfSpeaking = false;
    this.vads.clear();
    this.speakingNow.clear();
    this.sttQueues.clear();
    this.quietMs.clear();
    if (session) {
      await session.leave().catch(() => {});
      await session.close().catch(() => {});
    }
    if (id && this.meetings && this.meetings.get(id)) {
      this.meetings.update(id, { state: 'ended', session_id: null, ended_at: new Date().toISOString() });
    }
    this.poke();
    log('participant left ' + (id || ''));
    return { left: true, meeting_id: id };
  }

  info() {
    return {
      joined: !!this.session,
      meeting_id: this.meetingId,
      display_name: this.displayName || null,
      disclosed: this.disclosed,
      stt: this.voice ? this.voice.sttId : (this.stt ? this.stt.id : null),
      tts: this.voice ? this.voice.ttsId : (this.tts ? this.tts.id : null),
    };
  }

  async close() {
    if (this.session) await this.leave().catch(() => {});
    if (this.stt && this.stt !== this.voice && this.stt.close) await this.stt.close().catch(() => {});
    this.stt = null;
    this.tts = null;
    if (this.voice && this.voice.close) await this.voice.close().catch(() => {});
    this.voice = null;
  }
}
