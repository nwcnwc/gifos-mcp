// Streaming chat against any OpenAI-compatible /chat/completions endpoint.
// The body is messages only. Tools are never sent: this model speaks, and
// the user's own assistant does the work after the meeting.
// The key is an Authorization header and is stripped from errors.

export function scrub(text, secret) {
  const s = String(text == null ? '' : text);
  const key = String(secret || '');
  if (!key) return s;
  return s.split(key).join('[redacted]');
}

function endpoint(base, path) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!root) throw new Error('No conversation model is configured.');
  return root + path;
}

function headers(key) {
  const h = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (key) h.authorization = 'Bearer ' + key;
  return h;
}

async function readError(res, key) {
  let detail = '';
  try { detail = await res.text(); } catch (e) { detail = ''; }
  detail = scrub(detail, key).replace(/\s+/g, ' ').slice(0, 180);
  throw new Error('The conversation model returned ' + res.status + (detail ? ': ' + detail : '.'));
}

// Pulls text out of one SSE JSON payload. Tool-call deltas are ignored.
export function deltaText(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  if (!choice) return '';
  const delta = choice.delta || {};
  if (delta.tool_calls || delta.function_call) return '';
  const content = delta.content != null ? delta.content : (choice.message && choice.message.content);
  return typeof content === 'string' ? content : '';
}

// Streams text fragments. `onDelta` runs for each piece so the first clause
// can be spoken before the rest of the reply has arrived. `fetchImpl` and
// `signal` are injectable. A non-streaming JSON body is accepted too.
export async function chatDeltas(voice, messages, onDelta, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const key = voice && voice.key || '';
  const body = {
    model: voice.model,
    messages,
    stream: true,
  };
  const res = await fetchImpl(endpoint(voice.url, '/chat/completions'), {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) await readError(res, key);
  const emit = async (piece) => {
    if (!piece) return;
    if (typeof onDelta === 'function') await onDelta(piece);
  };
  const type = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '');
  if (!res.body || typeof res.body.getReader !== 'function' || /application\/json/.test(type)) {
    const whole = await res.json();
    const text = deltaText(whole) || (whole && whole.choices && whole.choices[0] && whole.choices[0].message
      ? String(whole.choices[0].message.content || '') : '');
    await emit(text);
    return text;
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
        const piece = deltaText(JSON.parse(data));
        if (piece) {
          out += piece;
          await emit(piece);
        }
      } catch (e) { /* a partial line stays buffered until the next chunk */ }
    }
  }
  return out;
}
