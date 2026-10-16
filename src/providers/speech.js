// Conversation voice and command replies. A command reply (including Grok
// Bot say) cancels whatever the conversation voice is still saying.
// The first clause is short so the first audio can start immediately.

const VOICES = new Set(['none', 'grok', 'local']);

export function clauses(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const words = sentences[i].split(' ');
    if (out.length === 0 && words.length > 6) {
      let cut = 4;
      for (let w = 3; w < Math.min(words.length - 1, 8); w++) {
        if (/[,;:]$/.test(words[w]) || words[w].toLowerCase() === 'and') { cut = w + 1; break; }
      }
      const head = words.slice(0, cut).join(' ').replace(/[,;:]$/, '');
      out.push(/[.!?]$/.test(head) ? head : head + '.');
      const rest = words.slice(cut).join(' ').trim();
      if (rest) out.push(rest);
    } else {
      out.push(sentences[i]);
    }
  }
  return out;
}

export class SpeechTurn {
  constructor() {
    this.respondToCommand = true;
    this.conversationVoice = 'none';
    this.commandActive = false;
    this.voice = null;
  }

  public() {
    return {
      respond_to_command: this.respondToCommand,
      conversation_voice: this.conversationVoice,
    };
  }

  set({ respond_to_command, conversation_voice }) {
    if (respond_to_command !== undefined) this.respondToCommand = !!respond_to_command;
    if (conversation_voice !== undefined) {
      const v = String(conversation_voice);
      if (!VOICES.has(v)) throw new Error('conversation_voice must be none, grok, or local.');
      this.conversationVoice = v;
    }
    return this.public();
  }

  // Stops an in-progress conversation line. Returns whether one was playing.
  yieldVoice() {
    const running = this.voice;
    if (!running) return false;
    this.voice = null;
    try { running.abort(); } catch (e) { /* already finished */ }
    return true;
  }

  beginCommand() {
    const yielded = this.yieldVoice();
    this.commandActive = true;
    return { speak: true, yielded };
  }

  endCommand() {
    this.commandActive = false;
  }

  // A command heard in the room. Off means stay quiet. Grok Bot say uses
  // beginCommand directly and is not blocked by this switch.
  onRoomCommand() {
    if (!this.respondToCommand) return { speak: false, yielded: false, reason: 'commands-off' };
    return this.beginCommand();
  }

  beginConversation() {
    if (this.conversationVoice === 'none') return { speak: false, reason: 'voice-off', engine: 'none' };
    if (this.commandActive) return { speak: false, reason: 'yield', engine: this.conversationVoice };
    const ac = new AbortController();
    this.voice = ac;
    return { speak: true, engine: this.conversationVoice, signal: ac.signal };
  }

  endConversation(ac) {
    if (this.voice === ac) this.voice = null;
  }
}

// Calls synth(clause, index) as soon as each clause is ready. The first
// clause is handed over before later clauses are synthesized.
export async function speakClauses(text, synth, signal) {
  const parts = clauses(text);
  const spoken = [];
  for (let i = 0; i < parts.length; i++) {
    if (signal && signal.aborted) return { spoken, yielded: true };
    await synth(parts[i], i);
    spoken.push(parts[i]);
  }
  return { spoken, yielded: false };
}
