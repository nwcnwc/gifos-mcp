// One Kokoro queue and one shared speech-to-text queue. A job keeps the
// meeting id it was asked with. A meeting the bot has left drops its jobs.
// Thinking is on for the meeting whose reply is being composed.

function meetingOf(req) {
  return String((req && (req.meetingId || req.meeting_id || req.sessionId || req.session_id)) || '');
}

export class SpeechQueue {
  constructor({ onThinking } = {}) {
    this.onThinking = typeof onThinking === 'function' ? onThinking : () => {};
    this.left = new Set();
    this.thinking = new Set();
    this.speaking = new Set();
    this.tts = Promise.resolve();
    this.stt = Promise.resolve();
    this.smartest = Promise.resolve();
  }

  leave(meetingId) {
    const id = String(meetingId || '');
    if (!id) return;
    this.left.add(id);
    this.setThinking(id, false);
  }

  isThinking(meetingId) {
    return this.thinking.has(String(meetingId || ''));
  }

  isSpeaking(meetingId) {
    return this.speaking.has(String(meetingId || ''));
  }

  setThinking(meetingId, on) {
    const id = String(meetingId || '');
    if (!id) return;
    const next = !!on;
    const prev = this.thinking.has(id);
    if (prev === next) return;
    if (next) this.thinking.add(id);
    else this.thinking.delete(id);
    try { this.onThinking(id, next); } catch (e) { /* the meeting must still finish the call */ }
  }

  run(role, req, fn) {
    const id = meetingOf(req);
    if (id && this.left.has(id)) return Promise.resolve({ dropped: true, role, meetingId: id });
    const lane = role === 'stt' ? 'stt' : (role === 'smartest' ? 'smartest' : 'tts');
    if (role === 'smartest' && id) this.setThinking(id, true);
    const job = this[lane].then(async () => {
      if (id && this.left.has(id)) return { dropped: true, role, meetingId: id };
      if (lane === 'tts' && id) this.speaking.add(id);
      try {
        const out = await fn();
        if (out && id && out.meetingId == null) out.meetingId = id;
        return out;
      } finally {
        if (role === 'smartest' && id) this.setThinking(id, false);
        if (lane === 'tts' && id) this.speaking.delete(id);
      }
    });
    this[lane] = job.then(() => {}, () => {});
    return job;
  }
}
