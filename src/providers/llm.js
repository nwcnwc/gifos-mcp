// OpenAI-compatible chat on the provider machine. The key is sent only as
// an Authorization header to the URL the operator configured. It is not
// written into the JSON body, the reply, or errors.

function endpoint(env, path) {
  const base = String(env.GIFOS_LLM_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('No conversation model is configured.');
  return base + path;
}

function headers(env) {
  const h = { 'content-type': 'application/json' };
  const key = String(env.GIFOS_LLM_KEY || '');
  if (key) h.authorization = 'Bearer ' + key;
  return h;
}

function bodyOf(env, extra) {
  const body = Object.assign({ model: env.GIFOS_LLM_MODEL || 'grok' }, extra);
  delete body.key;
  delete body.api_key;
  delete body.authorization;
  return body;
}

async function readError(res) {
  let detail = '';
  try { detail = await res.text(); } catch (e) { detail = ''; }
  const clipped = detail.replace(/\s+/g, ' ').slice(0, 180);
  throw new Error('The conversation model returned ' + res.status + (clipped ? ': ' + clipped : '.'));
}

// Streams text fragments from a chat completion. `fetchImpl` is injectable.
export async function chatText(env, messages, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(endpoint(env, '/chat/completions'), {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(bodyOf(env, { messages, stream: true })),
  });
  if (!res.ok) await readError(res);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const whole = await res.json();
    const text = whole && whole.choices && whole.choices[0] && whole.choices[0].message
      ? whole.choices[0].message.content : '';
    return String(text || '');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buf += dec.decode(step.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta && delta.content) out += delta.content;
      } catch (e) { /* a partial SSE line stays in buf */ }
    }
  }
  return out;
}

// Grok Voice: ask the configured endpoint for speech audio. The key stays
// in the header. The JSON body is the text and the voice name only.
export async function grokVoice(env, text, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(endpoint(env, '/audio/speech'), {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(bodyOf(env, { input: String(text || ''), voice: 'default' })),
  });
  if (!res.ok) await readError(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}
