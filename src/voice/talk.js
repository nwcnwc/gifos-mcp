// Speaks in the meeting. The model sees messages and nothing else: no tools,
// no functions. It does not send mail, touch a calendar, or do follow-up.
// That stays with the user's assistant, which tails the transcript and can
// cut in through say().
import { chatDeltas, scrub } from './llm.js';
import { readyClauses } from './clauses.js';

const SYSTEM = [
  'You are speaking out loud in a meeting. Reply in one or two short spoken sentences.',
  'You have no tools. Do not call tools, do not invent function calls, and do not claim you emailed anyone, changed a calendar, or did anything outside this conversation.',
  'Follow-up after the meeting belongs to someone else. Stay in the conversation.',
].join(' ');

function jobFor(map, id) {
  let job = map.get(id);
  if (!job) {
    job = { gen: 0, timer: null, ac: null };
    map.set(id, job);
  }
  return job;
}

export class MeetingVoice {
  constructor({ voice, live, speak, fetchImpl, pauseMs, log }) {
    this.voice = voice;
    this.live = live;
    this.speak = speak;
    this.fetchImpl = fetchImpl;
    this.log = log || (() => {});
    this.pauseMs = pauseMs == null ? (voice && voice.pauseMs != null ? voice.pauseMs : 700) : pauseMs;
    this.jobs = new Map();
    this.holding = new Set();
    this.closed = new Set();
    this.missed = new Set();
    this.off = null;
    if (live) this.off = live.onLine((row) => { if (row && row.kind === 'speech') this.hear(row); });
  }

  configured() {
    return !!(this.voice && this.voice.enabled && this.voice.url && this.voice.model);
  }

  hear(row) {
    if (!this.configured() || !row || !row.text || !row.meeting_id) return;
    if (this.closed.has(row.meeting_id)) return;
    if (this.holding.has(row.meeting_id)) {
      this.missed.add(row.meeting_id);
      return;
    }
    this.arm(row.meeting_id);
  }

  arm(meetingId) {
    const job = jobFor(this.jobs, meetingId);
    job.gen += 1;
    if (job.ac) {
      try { job.ac.abort(); } catch (e) { /* already finished */ }
      job.ac = null;
    }
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.timer = null;
      if (this.closed.has(meetingId)) return;
      this.reply(meetingId).catch((e) => this.log('voice: ' + scrub(e && e.message || e, this.voice && this.voice.key)));
    }, this.pauseMs);
    if (job.timer.unref) job.timer.unref();
  }

  cancel(meetingId) {
    const job = this.jobs.get(meetingId);
    if (!job) return false;
    const active = !!(job.timer || job.ac);
    job.gen += 1;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (job.ac) {
      try { job.ac.abort(); } catch (e) { /* already finished */ }
      job.ac = null;
    }
    return active;
  }

  openMeeting(meetingId) {
    this.closed.delete(meetingId);
  }

  closeMeeting(meetingId) {
    this.closed.add(meetingId);
    this.missed.delete(meetingId);
    this.holding.delete(meetingId);
    this.cancel(meetingId);
  }

  stopAll() {
    for (const id of [...this.jobs.keys()]) this.closeMeeting(id);
    if (this.off) this.off();
    this.off = null;
  }

  messagesFor(meetingId) {
    const rows = this.live.lines.filter((l) => l.meeting_id === meetingId).slice(-24);
    const messages = [{ role: 'system', content: SYSTEM }];
    for (const row of rows) {
      const text = scrub(row.text, this.voice.key);
      if (!text) continue;
      if (row.kind === 'speech') messages.push({ role: 'user', content: scrub(row.speaker, this.voice.key) + ': ' + text });
      else if (row.kind === 'voice' || row.kind === 'say') messages.push({ role: 'assistant', content: text });
    }
    return messages;
  }

  async reply(meetingId) {
    if (!this.configured() || this.closed.has(meetingId) || this.holding.has(meetingId)) return { spoke: false };
    const job = jobFor(this.jobs, meetingId);
    const token = job.gen;
    const ac = new AbortController();
    job.ac = ac;
    let buf = '';
    let emitted = 0;
    const spoken = [];
    const flush = async (done) => {
      const ready = readyClauses(buf, emitted, done);
      emitted = ready.emitted;
      for (const clause of ready.next) {
        if (job.gen !== token || ac.signal.aborted || this.closed.has(meetingId)) return;
        this.live.append({ meeting_id: meetingId, speaker: 'bot', text: clause, kind: 'voice' });
        spoken.push(clause);
        try { await this.speak(clause, ac.signal); } catch (e) {
          if (ac.signal.aborted || job.gen !== token) return;
        }
      }
    };
    try {
      await chatDeltas(this.voice, this.messagesFor(meetingId), async (delta) => {
        if (job.gen !== token || ac.signal.aborted) return;
        buf += scrub(String(delta || ''), this.voice.key);
        await flush(false);
      }, { fetchImpl: this.fetchImpl, signal: ac.signal });
      if (job.gen === token && !ac.signal.aborted) await flush(true);
    } catch (e) {
      if (e && e.name === 'AbortError') return { spoke: spoken.length > 0, spoken, aborted: true };
      if (job.gen !== token) return { spoke: spoken.length > 0, spoken, aborted: true };
      const message = scrub(e && e.message || e, this.voice.key);
      this.log('voice: ' + message);
      return { spoke: false, error: message };
    } finally {
      if (job.ac === ac) job.ac = null;
    }
    return { spoke: spoken.length > 0, spoken };
  }

  // The user's assistant cuts in. This cancels whatever the model was about
  // to say or was still saying, then speaks the given words as they are.
  async say(meetingId, text) {
    const clean = scrub(String(text || '').trim(), this.voice && this.voice.key);
    if (!clean) throw new Error('Nothing to say.');
    if (!this.configured()) {
      throw new Error('Meeting voice is off. Set GIFOS_LLM_KEY to use xAI Grok, or set GIFOS_LLM_URL and GIFOS_LLM_MODEL for another OpenAI-compatible endpoint.');
    }
    if (this.closed.has(meetingId)) throw new Error('Meeting voice has stopped for this meeting.');
    const interrupted = this.cancel(meetingId);
    this.holding.add(meetingId);
    const ac = new AbortController();
    try {
      this.live.append({ meeting_id: meetingId, speaker: 'assistant', text: clean, kind: 'say' });
      const played = await this.speak(clean, ac.signal);
      return { meeting_id: meetingId, spoken: true, interrupted_voice: interrupted, played: !!(played && played.played) };
    } finally {
      this.holding.delete(meetingId);
      if (this.missed.has(meetingId) && !this.closed.has(meetingId)) {
        this.missed.delete(meetingId);
        this.arm(meetingId);
      }
    }
  }
}
