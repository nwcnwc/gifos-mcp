// Providers, the two switches, and the short first sentence. No network
// except a local mock of the conversation endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistration, providerPublic } from '../../src/providers/registry.js';
import { SpeechTurn, clauses, speakClauses } from '../../src/providers/speech.js';
import { chatText, grokVoice } from '../../src/providers/llm.js';
import { captureSelectors, planCaptures, busesCovered, lineAllowed } from '../../src/transcript/lanes.js';
import { voiceInitScript } from '../../src/participant/page.js';

const KEY = 'sk-test-key-which-must-stay-here';

test('registration names the four local roles and does not carry a key', () => {
  const reg = providerRegistration();
  const roles = reg.roles.map((r) => r.role).sort();
  assert.deepEqual(roles, ['llm', 'say', 'stt', 'tts']);
  const blob = JSON.stringify(reg) + JSON.stringify(providerPublic({ GIFOS_LLM_URL: 'https://api.x.ai/v1', GIFOS_LLM_KEY: KEY }));
  assert.equal(blob.includes(KEY), false);
  assert.equal(blob.includes('api.x.ai'), false);
  assert.match(blob, /on-provider/);
  assert.equal(providerPublic({}).llm_configured, false);
  assert.equal(providerPublic({ GIFOS_LLM_URL: 'https://api.x.ai/v1' }).llm_configured, true);
});

test('the first clause is short, and a command abort skips the clauses after it', async () => {
  const text = 'Hello friend today, we should talk about the weather. Then we leave.';
  const parts = clauses(text);
  assert.ok(parts.length >= 3, parts.join(' | '));
  assert.ok(parts[0].split(/\s+/).length <= 6, parts[0]);
  const ac = new AbortController();
  const order = [];
  const done = await speakClauses(text, async (clause, i) => {
    order.push(clause);
    if (i === 1) ac.abort();
  }, ac.signal);
  assert.equal(order[0], parts[0]);
  assert.equal(done.yielded, true);
  assert.deepEqual(done.spoken, parts.slice(0, 2));
});

test('conversation voice yields while a command reply speaks', () => {
  const turn = new SpeechTurn();
  turn.set({ respond_to_command: true, conversation_voice: 'local' });
  const voice = turn.beginConversation();
  assert.equal(voice.speak, true);
  assert.equal(voice.engine, 'local');
  const cmd = turn.beginCommand();
  assert.equal(cmd.yielded, true);
  assert.equal(voice.signal.aborted, true);
  const blocked = turn.beginConversation();
  assert.equal(blocked.speak, false);
  assert.equal(blocked.reason, 'yield');
  turn.endCommand();
  const again = turn.beginConversation();
  assert.equal(again.speak, true);
  turn.endConversation(again.signal && turn.voice);
  const off = new SpeechTurn();
  off.set({ respond_to_command: false, conversation_voice: 'none' });
  assert.equal(off.onRoomCommand().speak, false);
  assert.equal(off.beginConversation().reason, 'voice-off');
  const say = off.beginCommand();
  assert.equal(say.speak, true, 'Grok Bot say still speaks when room commands are off');
});

test('grok and local calls keep the key in the header only', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (String(url).endsWith('/audio/speech')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello there."}}]}\n\n'));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return { ok: true, body: stream };
  };
  const env = { GIFOS_LLM_URL: 'https://api.x.ai/v1', GIFOS_LLM_KEY: KEY, GIFOS_LLM_MODEL: 'grok' };
  const text = await chatText(env, [{ role: 'user', content: 'hi' }], fetchImpl);
  assert.match(text, /Hello there/);
  const audio = await grokVoice(env, 'Hello there.', fetchImpl);
  assert.equal(audio.length, 3);
  for (const call of seen) {
    assert.equal(call.headers.authorization, 'Bearer ' + KEY);
    assert.equal(JSON.stringify(call.body).includes(KEY), false);
    assert.equal(call.body.key, undefined);
  }
});

test('stage, row, and stadium are all captured, and only with the label', () => {
  const selectors = captureSelectors();
  assert.deepEqual(selectors.map((s) => s.lane), ['row', 'stage', 'stadium']);
  const script = voiceInitScript();
  for (const spec of selectors) assert.ok(script.includes(spec.selector), spec.lane);
  const plan = planCaptures([
    { id: 's1', bus: 'stage', audio: true },
    { id: 'r1', bus: 'row', audio: true },
    { id: 'd1', bus: 'stadium', audio: true },
    { id: 'silent', bus: 'stadium', audio: false },
    { id: 'other', bus: 'lobby', audio: true },
  ]);
  assert.equal(plan.length, 3);
  const covered = busesCovered(plan);
  assert.equal(covered.stage && covered.row && covered.stadium, true);
  assert.equal(lineAllowed(false, 'hello'), false);
  assert.equal(lineAllowed(true, 'hello'), true);
  assert.equal(lineAllowed(true, '  '), false);
});
