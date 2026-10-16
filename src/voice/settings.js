// Voice settings to hand to Meet Bot. This module does not call a model
// and does not speak. See docs/MEETBOT-BRIDGE.md.

export const VOICE_GAP = 'Meeting Bot has no setVoice method (contract version 1). Conversation voice stays off until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const INTERJECT_GAP = 'Meeting Bot has no interject method (contract version 1). say posts chat only. A spoken line from the assistant needs MeetingBot.interject. See docs/MEETBOT-BRIDGE.md.';
export const HAND_GAP = 'Meeting Bot has no raiseHand method (contract version 1). The hand stays as it is. See docs/MEETBOT-BRIDGE.md.';
export const MIC_GAP = 'Meeting Bot has no setMic method (contract version 1). The bot has no microphone until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const CAMERA_GAP = 'Meeting Bot has no setCamera method (contract version 1). The bot has no camera until the app accepts the setting. See docs/MEETBOT-BRIDGE.md.';
export const CONTROLS_GAP = 'Meeting Bot has no meetingState method (contract version 1). Hand, microphone, and camera are not reported. See docs/MEETBOT-BRIDGE.md.';
export const SNAPSHOT_GAP = 'Meeting Bot has no snapshot method (contract version 1). A PNG of the Meet Bot page is saved when that page is open. See docs/MEETBOT-BRIDGE.md.';

// Kokoro is a setting for Meet Bot's local voice. This process does not install it.
export const KOKORO_APP = 'offline-tts-kokoro';
export const KOKORO_VOICE = 'af_heart';

export function scrub(text, secret) {
  const s = String(text == null ? '' : text);
  const key = String(secret || '');
  if (!key) return s;
  return s.split(key).join('[redacted]');
}

// Kokoro unless the environment names an HTTP stand-in or turns speech off.
// The URL stays in the object Meet Bot receives. It is not a request from here.
function localTts(voice) {
  const t = (voice && voice.tts) || {};
  if (t.engine === 'http') return { engine: 'http', url: t.url || '' };
  if (t.engine === 'none') return { engine: 'none' };
  return { engine: 'kokoro', app: t.app || KOKORO_APP, voice: t.voice || KOKORO_VOICE };
}

function ttsPublic(voice) {
  if (!voice || voice.conversationVoice !== 'local') return null;
  const t = localTts(voice);
  if (t.engine === 'http') return { engine: 'http' };
  if (t.engine === 'none') return { engine: 'none' };
  return { engine: 'kokoro', app: t.app, voice: t.voice };
}

// The object passed to MeetingBot.setVoice. llm and tts are present only for
// local voice, and only then does the key leave this process — and only if the
// driver has already seen setVoice on the app.
export function voiceSettings(voice) {
  const settings = {
    respond_to_command: !!(voice && voice.respondToCommand),
    conversation_voice: (voice && voice.conversationVoice) || 'none',
  };
  if (voice && voice.sttUrl) settings.stt = { url: voice.sttUrl };
  if (settings.conversation_voice === 'local') {
    settings.llm = {
      url: voice.url || '',
      model: voice.model || '',
      key: voice.key || '',
    };
    settings.tts = localTts(voice);
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
    tts: ttsPublic(v),
    stt: v.sttUrl ? 'configured' : null,
    handed,
    gap: handed ? null : ((handoff && handoff.gap) || VOICE_GAP),
  };
}
