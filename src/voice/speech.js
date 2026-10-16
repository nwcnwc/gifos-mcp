// Turns one spoken clause into audio. OpenAI-compatible hosts use
// POST /audio/speech. The suggested xAI host uses POST /tts. The key stays
// in the header either way.

import { scrub } from './llm.js';

export function speechRequest(voice, text) {
  const base = String(voice.ttsUrl || voice.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('No speech endpoint is configured.');
  const path = voice.ttsPath || '/audio/speech';
  const xai = path === '/tts' || path.endsWith('/tts');
  const body = xai
    ? { text: String(text || ''), voice_id: voice.ttsVoice || 'eve', language: 'en' }
    : { model: voice.ttsModel || 'tts-1', input: String(text || ''), voice: voice.ttsVoice || 'alloy' };
  const headers = { 'content-type': 'application/json', accept: 'audio/*' };
  if (voice.key) headers.authorization = 'Bearer ' + voice.key;
  return { url: base + path, body, headers };
}

export async function synthesize(voice, text, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const req = speechRequest(voice, text);
  const res = await fetchImpl(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { detail = ''; }
    detail = scrub(detail, voice.key).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error('Speech synthesis returned ' + res.status + (detail ? ': ' + detail : '.'));
  }
  return Buffer.from(await res.arrayBuffer());
}
