// Hears a line and decides whether the bot speaks.
// A command (a slash, a bang, or the bot's name first) is answered at once
// when respond-to-command is on, and that reply cancels conversation voice.
// Conversation waits out the pause, then speaks with Grok Voice or the local
// model plus Kokoro. The first clause leaves as soon as it is ready.

import { clauses } from './speech.js';

export function isCommand(text, names) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s[0] === '/' || s[0] === '!') return true;
  const first = s.split(/\s+/)[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  if (!first) return false;
  if (first === 'bot') return true;
  for (const name of names || []) {
    const n = String(name || '').split(/\s+/)[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    if (n && n === first) return true;
  }
  return false;
}

// clauses() is stable for a growing buffer: a finished clause is one that
// already has another clause after it, or the final clause once the model stops.
export function readyClauses(buffer, emitted, done) {
  const parts = clauses(buffer);
  let n = parts.length;
  if (!done && n > 0 && !/[.!?]"?$/.test(parts[n - 1])) n -= 1;
  if (n < emitted) n = emitted;
  return { parts, next: parts.slice(emitted, n), emitted: n };
}

function messagesFor(kind, text) {
  const system = kind === 'command'
    ? 'You are the meeting bot. Answer in one short sentence. Do not mention passwords.'
    : 'You are the meeting bot. Answer in one or two short sentences. Do not mention passwords.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: String(text || '').slice(0, 2000) },
  ];
}

export class Converse {
  constructor({ turn, complete, speakText, pauseMs }) {
    if (!turn) throw new Error('converse needs the speech switches');
    this.turn = turn;
    this.complete = complete;
    this.speakText = speakText;
    this.pauseMs = pauseMs == null ? 700 : Math.max(0, Number(pauseMs) || 0);
    this.timer = null;
    this.pending = null;
    this.gen = 0;
  }

  onHeard(line) {
    const text = String((line && line.text) || '').trim();
    if (!text || (line && line.self)) return Promise.resolve({ spoke: false, reason: 'skip' });
    if (isCommand(text, line && line.names)) return this.answerCommand(line, text);
    if (line && line.yourTurn === false) return Promise.resolve({ spoke: false, reason: 'wait' });
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve({ spoke: false, reason: 'superseded' });
      this.pending = { line, text, resolve };
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const held = this.pending;
        this.pending = null;
        this.timer = null;
        if (!held) return;
        this.answerConversation(held.line, held.text).then(held.resolve, (e) => held.resolve({ spoke: false, reason: 'error', error: String(e && e.message || e) }));
      }, this.pauseMs);
    });
  }

  cancelWait() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) this.pending.resolve({ spoke: false, reason: 'superseded' });
    this.pending = null;
  }

  async answerCommand(line, text) {
    this.cancelWait();
    const gate = this.turn.onRoomCommand();
    if (!gate.speak) return { spoke: false, reason: gate.reason || 'commands-off', yielded: !!gate.yielded };
    const token = ++this.gen;
    try {
      const spoken = await this.speakReply(text, 'command', null, token);
      return { spoke: spoken.length > 0, kind: 'command', spoken, yielded: !!gate.yielded, lane: (line && line.lane) || '' };
    } finally {
      if (this.gen === token) this.turn.endCommand();
    }
  }

  async answerConversation(line, text) {
    const gate = this.turn.beginConversation();
    if (!gate.speak) return { spoke: false, reason: gate.reason || 'voice-off', engine: gate.engine || 'none' };
    const token = ++this.gen;
    try {
      const spoken = await this.speakReply(text, 'conversation', gate, token);
      return { spoke: spoken.length > 0, kind: 'conversation', engine: gate.engine, spoken, lane: (line && line.lane) || '' };
    } finally {
      this.turn.endConversation(gate.signal);
    }
  }

  async speakReply(text, kind, gate, token) {
    const signal = gate && gate.signal;
    const engine = (gate && gate.engine) || 'local';
    const spoken = [];
    let buf = '';
    let emitted = 0;
    const flush = async (done) => {
      const ready = readyClauses(buf, emitted, done);
      emitted = ready.emitted;
      for (const clause of ready.next) {
        if (this.gen !== token) return;
        if (signal && signal.aborted) return;
        try {
          await this.speakText(clause, { signal, engine, kind });
        } catch (e) {
          return spoken;
        }
        if (this.gen !== token || (signal && signal.aborted)) return spoken;
        spoken.push(clause);
      }
    };
    if (typeof this.complete === 'function') {
      try {
        await this.complete(messagesFor(kind, text), async (delta) => {
          buf += String(delta || '');
          await flush(false);
        });
      } catch (e) {
        if (!buf.trim() && kind === 'command') buf = 'I heard you.';
      }
    } else if (kind === 'command') {
      buf = 'I heard you.';
    }
    if (!buf.trim() && kind === 'command') buf = 'I heard you.';
    await flush(true);
    return spoken;
  }
}
