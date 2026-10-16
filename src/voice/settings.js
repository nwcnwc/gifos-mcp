// Voice settings to hand to Meet Bot. This module does not call a model
// and does not speak. See docs/MEETBOT-BRIDGE.md.

export const VOICE_GAP = 'Meeting Bot has no setVoice method (contract version 1). Conversation voice stays off until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const INTERJECT_GAP = 'Meeting Bot has no interject method (contract version 1). say posts chat only. A spoken line from the assistant needs MeetingBot.interject. See docs/MEETBOT-BRIDGE.md.';

export function scrub(text, secret) {
  const s = String(text == null ? '' : text);
  const key = String(secret || '');
  if (!key) return s;
  return s.split(key).join('[redacted]');
}

// The object passed to MeetingBot.setVoice. llm is present only for local
// voice, and only then does the key leave this process — and only if the
// driver has already seen setVoice on the app.
export function voiceSettings(voice) {
  const settings = {
    respond_to_command: !!(voice && voice.respondToCommand),
    conversation_voice: (voice && voice.conversationVoice) || 'none',
  };
  if (settings.conversation_voice === 'local') {
    settings.llm = {
      url: voice.url || '',
      model: voice.model || '',
      key: voice.key || '',
    };
  }
  return settings;
}

export function voicePublic(voice, handoff) {
  const v = voice || {};
  const handed = !!(handoff && handoff.applied);
  return {
    respond_to_command: !!v.respondToCommand,
    conversation_voice: v.conversationVoice || 'none',
    model: v.conversationVoice === 'local' ? (v.model || null) : null,
    handed,
    gap: handed ? null : ((handoff && handoff.gap) || VOICE_GAP),
  };
}
