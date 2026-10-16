// Meeting voice against a local OpenAI-compatible streaming server.
// No browser, and no call to any host but 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { LiveTranscript, watchCaptions } from '../../src/voice/live.js';
import { MeetingVoice } from '../../src/voice/talk.js';
import { chatDeltas } from '../../src/voice/llm.js';
import { speechRequest, synthesize } from '../../src/voice/speech.js';
import { clauses, readyClauses } from '../../src/voice/clauses.js';
import { mouthInitScript } from '../../src/voice/mouth.js';

const KEY = 'sk-test-key-which-must-stay-here';
const FIRST = 'Hello there friend today, we should talk';
const SECOND = ' about the weather.';

class FakeBot {
  constructor() { this.calls = []; this.lines = {}; this.seq = 0; }
  async ensureStarted() {}
  async join() {
    const id = 'mt_' + (++this.seq);
    this.lines[id] = [];
    this.calls.push(['join', id]);
    return id;
  }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe() {}
  async say() { throw new Error('chat say should not be used for voice'); }
  async transcript(id) { return (this.lines[id] || []).join('\n'); }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
}

function startMock() {
  const requests = [];
  let releaseHold;
  const hold = new Promise((r) => { releaseHold = r; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = {}; }
    const rec = { method: req.method, url: req.url, authorization: req.headers.authorization || '', body, clientClosed: false };
    requests.push(rec);
    const blob = JSON.stringify(body);
    if (blob.includes('__boom__')) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('refused ' + KEY);
      return;
    }
    if (req.url.endsWith('/audio/speech') || req.url.endsWith('/tts')) {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.from('RIFF'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: {"choices":[{"delta":{"content":' + JSON.stringify(FIRST) + '}}]}\n');
    let gone = false;
    req.on('close', () => { gone = true; rec.clientClosed = true; });
    await new Promise((resolve) => {
      const finish = () => resolve();
      req.on('close', finish);
      hold.then(finish);
    });
    if (gone || res.writableEnded) return;
    res.write('\n');
    res.write('data: {"choices":[{"delta":{"content":' + JSON.stringify(SECOND) + '}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/v1',
        requests,
        release: () => releaseHold(),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function voiceAt(url, extra = {}) {
  return {
    enabled: true,
    url,
    key: KEY,
    model: 'local-model',
    ttsUrl: url,
    ttsPath: '/audio/speech',
    ttsVoice: 'alloy',
    ttsModel: 'tts-1',
    pauseMs: 0,
    ...extra,
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('the first clause is ready before the model finishes the sentence', () => {
  const early = readyClauses(FIRST, 0, false);
  assert.deepEqual(early.next, ['Hello there friend today.']);
  const later = readyClauses(FIRST + SECOND, early.emitted, true);
  assert.equal(later.next[0], 'we should talk about the weather.');
  const parts = clauses('Hello friend today, we should talk about the weather. Then we leave.');
  assert.ok(parts.length >= 3, parts.join(' | '));
  assert.ok(parts[0].split(/\s+/).length <= 6, parts[0]);
});

test('speech requests keep the key in the header', () => {
  const xai = speechRequest({ ttsUrl: 'https://api.x.ai/v1', ttsPath: '/tts', ttsVoice: 'eve', key: KEY }, 'Hello');
  assert.equal(xai.url, 'https://api.x.ai/v1/tts');
  assert.deepEqual(xai.body, { text: 'Hello', voice_id: 'eve', language: 'en' });
  assert.equal(xai.headers.authorization, 'Bearer ' + KEY);
  assert.equal(JSON.stringify(xai.body).includes(KEY), false);
  const openai = speechRequest({ ttsUrl: 'http://127.0.0.1:9/v1', ttsPath: '/audio/speech', ttsVoice: 'alloy', ttsModel: 'tts-1', key: KEY }, 'Hello');
  assert.equal(openai.url, 'http://127.0.0.1:9/v1/audio/speech');
  assert.deepEqual(openai.body, { model: 'tts-1', input: 'Hello', voice: 'alloy' });
  assert.equal(JSON.stringify(openai.body).includes(KEY), false);
});

test('the mouth script does not carry a key', () => {
  const src = mouthInitScript();
  assert.match(src, /__gifosPlayEncoded/);
  assert.match(src, /__gifosQuiet/);
  assert.equal(src.includes(KEY), false);
  assert.equal(src.includes('GIFOS_LLM_KEY'), false);
  assert.equal(src.includes('authorization'), false);
  assert.equal(src.includes('Bearer'), false);
});

test('a streaming chat has no tools, and an error does not echo the key', { timeout: 10000 }, async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const voice = voiceAt(mock.url);
  const spoken = [];
  let sawFirst;
  const first = new Promise((r) => { sawFirst = r; });
  const pending = chatDeltas(voice, [{ role: 'user', content: 'What next?' }], async (delta) => {
    spoken.push(delta);
    if (spoken.length === 1) sawFirst();
  });
  await first;
  const call = mock.requests[0];
  assert.equal(spoken[0], FIRST);
  mock.release();
  const out = await pending;
  assert.equal(out, FIRST + SECOND);
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.authorization, 'Bearer ' + KEY);
  assert.deepEqual(Object.keys(call.body).sort(), ['messages', 'model', 'stream']);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.model, 'local-model');
  assert.equal('tools' in call.body, false);
  assert.equal(JSON.stringify(call.body).includes(KEY), false);
  const audio = await synthesize(voice, 'Hello there.', {});
  assert.equal(audio.toString(), 'RIFF');
  const speech = mock.requests.find((r) => r.url.endsWith('/audio/speech'));
  assert.equal(speech.authorization, 'Bearer ' + KEY);
  assert.equal(JSON.stringify(speech.body).includes(KEY), false);
  await assert.rejects(
    () => chatDeltas(voice, [{ role: 'user', content: '__boom__ ' + KEY }], null),
    (e) => {
      assert.match(e.message, /returned 500/);
      assert.match(e.message, /refused \[redacted\]/);
      assert.equal(String(e.message).includes(KEY), false);
      return true;
    },
  );
});

test('say cuts off the model, and the assistant still has the transcript after the meeting', { timeout: 10000 }, async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-voice-'));
  const cfg = loadConfig({
    GIFOS_MCP_HOME: home,
    GIFOS_URL: 'http://127.0.0.1:19510',
    GIFOS_LLM_URL: mock.url,
    GIFOS_LLM_KEY: KEY,
    GIFOS_LLM_MODEL: 'local-model',
    GIFOS_TURN_PAUSE_MS: '0',
    GIFOS_TTS_PATH: '/audio/speech',
  });
  const meetings = new MeetingStore(home);
  const bot = new FakeBot();
  const live = new LiveTranscript(home);
  const spoken = [];
  const voice = new MeetingVoice({
    voice: cfg.voice,
    live,
    pauseMs: 0,
    fetchImpl: globalThis.fetch,
    speak: async (text) => { spoken.push(text); return { played: true }; },
  });
  const captions = watchCaptions({ meetings, bot, live, intervalMs: 20, botName: 'notes-test' });
  t.after(() => { captions.stopAll(); voice.stopAll(); });
  const server = createServer({ cfg, meetings, bot, voice, live, captions, botName: 'notes-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  const updates = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (note) => { updates.push(note.params.uri); });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const json = async (name, args) => JSON.parse((await call(name, args)).content[0].text);

  const created = await json('create_meeting', { topic: 'Demo meeting' });
  await json('start_meeting', { meeting_id: created.meeting_id });
  const listed = await client.listResources();
  const uri = 'gifos://meeting/' + created.meeting_id + '/transcript';
  assert.ok(listed.resources.some((r) => r.uri === uri));
  await client.subscribeResource({ uri });

  bot.lines.mt_1.push('Ada: What should we do next?');
  for (let i = 0; i < 50 && spoken.length < 1; i++) await delay(20);
  assert.equal(spoken[0], 'Hello there friend today.');
  const chat = mock.requests.find((r) => r.url.endsWith('/chat/completions'));
  assert.ok(chat, 'the speaking model was called');
  assert.equal(chat.authorization, 'Bearer ' + KEY);
  assert.deepEqual(Object.keys(chat.body).sort(), ['messages', 'model', 'stream']);
  assert.equal(chat.body.tools, undefined);
  assert.equal(JSON.stringify(chat.body).includes(KEY), false);
  assert.match(chat.body.messages[0].content, /no tools/i);
  assert.match(chat.body.messages.map((m) => m.content).join('\n'), /Ada: What should we do next/);

  const said = await json('say', { meeting_id: created.meeting_id, text: 'I will take that question.' });
  assert.equal(said.spoken, true);
  assert.equal(said.interrupted_voice, true);
  assert.equal(spoken.at(-1), 'I will take that question.');
  assert.equal(spoken.some((s) => /weather/.test(s)), false);
  await delay(30);
  assert.equal(mock.requests.filter((r) => r.url.endsWith('/chat/completions')).length, 1);

  const tail = await json('tail_transcript', { meeting_id: created.meeting_id });
  assert.deepEqual(tail.lines.map((l) => l.kind), ['speech', 'voice', 'say']);
  assert.equal(tail.lines[2].text, 'I will take that question.');
  assert.equal(JSON.stringify(tail).includes(KEY), false);
  const again = await json('tail_transcript', { meeting_id: created.meeting_id, since: tail.lines[0].seq });
  assert.equal(again.lines[0].kind, 'voice');

  const resource = await client.readResource({ uri });
  const rows = resource.contents[0].text.split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.equal(resource.contents[0].mimeType, 'application/x-ndjson');

  bot.lines.mt_1.push('Bob: One more thing');
  for (let i = 0; i < 50 && updates.length < 1; i++) await delay(20);
  assert.ok(updates.includes(uri));

  const ended = await json('end_meeting', { meeting_id: created.meeting_id });
  assert.equal(ended.state, 'ended');
  const after = await json('tail_transcript', { meeting_id: created.meeting_id });
  assert.ok(after.lines.length >= 3);
  const callsBefore = mock.requests.filter((r) => r.url.endsWith('/chat/completions')).length;
  voice.hear({ meeting_id: created.meeting_id, speaker: 'Ada', text: 'still there?', kind: 'speech' });
  await delay(40);
  assert.equal(mock.requests.filter((r) => r.url.endsWith('/chat/completions')).length, callsBefore);

  const file = path.join(home, 'transcripts', created.meeting_id + '.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false);
  const restored = new LiveTranscript(home);
  assert.ok(restored.tail(created.meeting_id, 0).lines.length >= 3);
  await client.close();
});

test('captions are not stored twice, and the bot name is skipped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-live-'));
  const live = new LiveTranscript(home);
  const id = 'm_abcde12345';
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi', 'notes-test');
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi', 'notes-test');
  assert.deepEqual(live.tail(id, 0).lines.map((l) => l.speaker + ': ' + l.text), ['Ada: hello', 'Bob: hi']);
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi\nAda: again', 'notes-test');
  assert.equal(live.tail(id, 0).lines.at(-1).text, 'again');
  assert.equal(live.tail(id, 0).lines.length, 3);
});
