// Voice is a setting handed to Meet Bot. The page script does not call a
// model and this process does not play audio into the meeting. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { MeetingBotDriver } from '../../src/driver.js';
import { LiveTranscript, watchCaptions } from '../../src/voice/live.js';
import { voiceSettings, scrub } from '../../src/voice/settings.js';
import { bridgeScript, hostRoles } from '../../src/voice/providers.js';

const KEY = 'sk-test-key-which-must-stay-here';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function jsFiles(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) jsFiles(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('src and bin do not call a chat model or play into the meeting', () => {
  const forbidden = ['/chat/completions', '/audio/speech', '/tts', '__gifosPlayEncoded', '__gifosQuiet', 'MeetingVoice', 'chatDeltas', 'mouthInitScript'];
  const files = [...jsFiles(path.join(ROOT, 'src'), []), ...jsFiles(path.join(ROOT, 'bin'), [])];
  assert.ok(files.length > 5);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      assert.equal(src.includes(needle), false, path.relative(ROOT, file) + ' contains ' + needle);
    }
  }
  const page = bridgeScript() + bridgeScript({ hostRoles: ['tts', 'smartest', 'stt'] });
  for (const needle of forbidden) {
    assert.equal(page.includes(needle), false, 'the page bridge contains ' + needle);
  }
  assert.equal(page.includes('__gifosHostCall'), true);
  assert.equal(page.includes('__gifosMcpSpeak'), false);
  for (const rel of [
    'src/voice/talk.js', 'src/voice/llm.js', 'src/voice/speech.js', 'src/voice/clauses.js', 'src/voice/mouth.js',
    'src/voice/sidecar.py', 'src/voice/client.js', 'src/tts.js', 'src/participant/session.js',
    'src/providers/mouth.js', 'src/providers/llm.js', 'src/audio/tts.js', 'src/audio/stt.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }
});

test('local voice settings name providers, and public text does not carry the key', () => {
  const voice = {
    respondToCommand: true,
    conversationVoice: 'local',
    url: 'http://127.0.0.1:9/v1',
    model: 'local-model',
    key: KEY,
  };
  const settings = voiceSettings(voice);
  assert.equal(settings.llm.provider, 'smartest');
  assert.equal('key' in settings.llm, false);
  assert.equal('url' in settings.llm, false);
  assert.equal(settings.tts.provider, 'tts');
  assert.equal(settings.tts.engine, 'kokoro');
  assert.equal(settings.tts.app, 'mcp-tts-kokoro');
  assert.equal(settings.tts.voice, 'af_heart');
  assert.equal(JSON.stringify(settings).includes(KEY), false);
  assert.equal(JSON.stringify(settings).includes('127.0.0.1'), false);
  assert.equal('llm' in voiceSettings({ ...voice, conversationVoice: 'grok' }), false);
  assert.equal('tts' in voiceSettings({ ...voice, conversationVoice: 'grok' }), false);
  assert.equal('llm' in voiceSettings({ ...voice, conversationVoice: 'none' }), false);
  assert.equal('tts' in voiceSettings({ ...voice, conversationVoice: 'none' }), false);
  assert.equal(scrub('failed ' + KEY, KEY), 'failed [redacted]');
  assert.equal(scrub('fine', ''), 'fine');
});

test('the key stays out of the page until MeetingBot.setVoice exists', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-drv-'));
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510', GIFOS_LLM_KEY: KEY });
  const driver = new MeetingBotDriver(cfg, { name: 'harbor-maple', password: 'quiet-cedar-42' });
  const seen = [];
  driver.state = 'ready';
  driver.bot = {
    app: { isClosed: () => false },
    frame: {
      evaluate(fn, arg) {
        seen.push({ src: String(fn), arg });
        if (arg === undefined) return Promise.resolve(false);
        return Promise.resolve(true);
      },
    },
  };
  const settings = voiceSettings(cfg.voice);
  assert.equal(settings.llm.provider, 'smartest');
  assert.equal('key' in settings.llm, false);
  const missing = await driver.setVoice(settings);
  assert.equal(missing.applied, false);
  assert.match(missing.gap, /setVoice/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].arg, undefined);
  assert.equal(JSON.stringify(seen).includes(KEY), false);

  seen.length = 0;
  driver.bot.frame.evaluate = (fn, arg) => {
    seen.push({ src: String(fn), arg });
    if (arg === undefined) return Promise.resolve(true);
    return Promise.resolve({ ok: true });
  };
  const handed = await driver.setVoice(settings);
  assert.equal(handed.applied, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].arg, undefined);
  assert.equal(seen[1].arg.llm.provider, 'smartest');
  assert.equal('key' in seen[1].arg.llm, false);
  assert.equal(seen[1].src.includes('setVoice'), true);

  seen.length = 0;
  driver.bot.frame.evaluate = (fn, arg) => {
    seen.push(arg);
    if (arg === undefined) return Promise.resolve(false);
    return Promise.resolve(true);
  };
  const quiet = await driver.interject('mt_1', 'Hello');
  assert.equal(quiet.applied, false);
  assert.match(quiet.gap, /interject/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], undefined);

  seen.length = 0;
  const hand = await driver.raiseHand('mt_1', true);
  assert.equal(hand.applied, false);
  assert.match(hand.gap, /raiseHand/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], undefined);
  const mic = await driver.setMic('mt_1', false);
  const cam = await driver.setCamera('mt_1', true);
  assert.match(mic.gap, /setMic/);
  assert.match(cam.gap, /setCamera/);
  assert.equal(seen.every((arg) => arg === undefined), true);

  seen.length = 0;
  driver.bot.frame.evaluate = (fn, arg) => {
    seen.push({ src: String(fn), arg });
    if (arg === undefined) return Promise.resolve(true);
    return Promise.resolve({ hand: true });
  };
  const up = await driver.raiseHand('mt_1', true);
  assert.equal(up.applied, true);
  assert.equal(seen[1].arg.on, true);
  assert.equal(seen[1].src.includes('raiseHand'), true);
  assert.equal(JSON.stringify(seen).includes(KEY), false);
});

class FakeBot {
  constructor() { this.calls = []; this.lines = {}; this.seq = 0; this.voice = null; }
  async ensureStarted() {}
  async join() {
    const id = 'mt_' + (++this.seq);
    this.lines[id] = [];
    this.calls.push(['join', id]);
    return id;
  }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe() {}
  async say() { throw new Error('chat say should not be used for a spoken line'); }
  async setVoice(settings) {
    this.voice = settings;
    this.calls.push(['setVoice', settings]);
    return { applied: true, result: { ...settings, text_role: 'smartest' } };
  }
  async interject(id, text) {
    this.calls.push(['interject', id, text]);
    return { applied: true };
  }
  async transcript(id) { return (this.lines[id] || []).join('\n'); }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
}

test('say and the transcript go through Meet Bot, and the key stays out of tool text', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-voice-'));
  const cfg = loadConfig({
    GIFOS_MCP_HOME: home,
    GIFOS_URL: 'http://127.0.0.1:19510',
    GIFOS_LLM_URL: 'http://127.0.0.1:9/v1',
    GIFOS_LLM_KEY: KEY,
    GIFOS_LLM_MODEL: 'local-model',
    GIFOS_TTS_URL: 'http://127.0.0.1:10/voice',
    GIFOS_STT_URL: 'http://127.0.0.1:11/captions',
  });
  const meetings = new MeetingStore(home);
  const bot = new FakeBot();
  const live = new LiveTranscript(home);
  const captions = watchCaptions({ meetings, bot, live, intervalMs: 20, botName: 'notes-test' });
  t.after(() => captions.stopAll());
  const server = createServer({ cfg, meetings, bot, live, captions, botName: 'notes-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  const updates = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (note) => { updates.push(note.params.uri); });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const json = async (name, args) => JSON.parse((await call(name, args)).content[0].text);

  const created = await json('create_meeting', { topic: 'Demo meeting' });
  await json('start_meeting', { meeting_id: created.meeting_id });
  // Joining hands Meet Bot its version 2 switches. No provider, URL, or key.
  assert.deepEqual(bot.voice, { respond_to_command: true, speak: true });
  assert.equal(bot.calls.some((c) => c[0] === 'say'), false);

  const status = await json('status');
  assert.equal(status.voice.handed, true);
  assert.equal(status.voice.gap, null);
  assert.equal(status.voice.conversation_voice, 'local');
  assert.equal(status.voice.model, 'local-model');
  assert.equal(JSON.stringify(status).includes(KEY), false);
  assert.equal(JSON.stringify(status).includes('127.0.0.1:9'), false);
  assert.equal(JSON.stringify(status).includes('127.0.0.1:10'), false);
  assert.equal(JSON.stringify(status).includes('127.0.0.1:11'), false);
  assert.equal(JSON.stringify(status).includes('api.x.ai'), false);
  assert.equal(status.voice.tts.engine, 'http');
  assert.equal(status.voice.stt, 'configured');

  const uri = 'gifos://meeting/' + created.meeting_id + '/transcript';
  const listed = await client.listResources();
  assert.ok(listed.resources.some((r) => r.uri === uri));
  await client.subscribeResource({ uri });
  bot.lines.mt_1.push('Ada: What should we do next?');
  for (let i = 0; i < 50 && updates.length < 1; i++) await delay(20);
  assert.ok(updates.includes(uri));

  const said = await json('say', { meeting_id: created.meeting_id, text: 'I will take that question.' });
  assert.deepEqual(said, { meeting_id: created.meeting_id, spoken: true });
  assert.deepEqual(bot.calls.filter((c) => c[0] === 'interject'), [['interject', 'mt_1', 'I will take that question.']]);
  assert.equal(JSON.stringify(said).includes(KEY), false);

  const tail = await json('tail_transcript', { meeting_id: created.meeting_id });
  assert.deepEqual(tail.lines.map((l) => l.kind), ['speech', 'spoken']);
  assert.equal(tail.lines[0].speaker, 'Ada');
  assert.equal(tail.lines[0].text, 'What should we do next?');
  assert.equal(tail.lines[1].speaker, 'notes-test');
  assert.equal(tail.lines[1].text, 'I will take that question.');
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents[0].mimeType, 'application/x-ndjson');
  assert.match(resource.contents[0].text, /What should we do next/);
  assert.equal(resource.contents[0].text.includes(KEY), false);

  const grok = await json('set_voice', { conversation_voice: 'grok', respond_to_command: false });
  assert.equal(grok.conversation_voice, 'grok');
  assert.equal(grok.respond_to_command, false);
  assert.equal(grok.model, null);
  assert.equal(grok.handed, true);
  assert.deepEqual(bot.voice, { respond_to_command: false, speak: true });
  const quiet = await json('set_voice', { conversation_voice: 'none' });
  assert.equal(quiet.handed, true);
  assert.deepEqual(bot.voice, { respond_to_command: false, speak: false });
  assert.equal(JSON.stringify(grok).includes(KEY), false);

  bot.interject = async () => { throw new Error('refused ' + KEY); };
  const boom = await call('say', { meeting_id: created.meeting_id, text: 'again' });
  assert.equal(boom.isError, true);
  assert.match(boom.content[0].text, /refused \[redacted\]/);
  assert.equal(boom.content[0].text.includes(KEY), false);

  const ended = await json('end_meeting', { meeting_id: created.meeting_id });
  assert.equal(ended.state, 'ended');
  const after = await json('tail_transcript', { meeting_id: created.meeting_id });
  assert.equal(after.lines.length, 2);
  const file = path.join(home, 'transcripts', created.meeting_id + '.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false);
  await client.close();
});

// gifos-apps-source a83ff5c. MeetingBot.setVoice throws this when the
// argument still carries the old voice object (conversation_voice, llm, tts,
// or stt, including a URL). Smartest and Text to speech come from the host.
const NEW_MEET_BOT_VOICE = 'Voice uses the GifOS AI settings (Smartest and Text to speech).';

function oldVoiceCall(settings) {
  return !!(settings && (settings.conversation_voice != null || settings.llm || settings.tts || settings.stt));
}

test('join_meeting hands the new Meet Bot speak and respond_to_command, not the old voice call', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-newvoice-'));
  const cfg = loadConfig({
    GIFOS_MCP_HOME: home,
    GIFOS_URL: 'http://127.0.0.1:19510',
    GIFOS_LLM_URL: 'http://127.0.0.1:9/v1',
    GIFOS_LLM_KEY: KEY,
    GIFOS_LLM_MODEL: 'local-model',
  });
  assert.deepEqual(hostRoles(cfg), ['tts', 'smartest']);
  const bot = {
    calls: [],
    seq: 0,
    async ensureStarted() {},
    async join() {
      const id = 'mt_' + (++this.seq);
      this.calls.push(['join', id]);
      return id;
    },
    async transcribe() {},
    async setVoice(settings) {
      this.calls.push(['setVoice', settings]);
      if (oldVoiceCall(settings)) throw new Error(NEW_MEET_BOT_VOICE);
      return { applied: true, result: settings };
    },
    async info() { return { state: 'ready', bot_name: 'notes-test' }; },
  };
  const meetings = new MeetingStore(home);
  const server = createServer({ cfg, meetings, bot, botName: 'notes-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const joined = await client.callTool({
    name: 'join_meeting',
    arguments: { link: 'https://gifos.app/meet/voice-room-1', password: 'room-secret' },
  });
  assert.notEqual(joined.isError, true, joined.content[0].text);
  const body = JSON.parse(joined.content[0].text);
  assert.equal(body.state, 'live');
  assert.equal(joined.content[0].text.includes(NEW_MEET_BOT_VOICE), false);
  const handed = bot.calls.filter((c) => c[0] === 'setVoice');
  assert.equal(handed.length, 1);
  assert.deepEqual(handed[0][1], { respond_to_command: true, speak: true });
  assert.equal(JSON.stringify(handed).includes(KEY), false);
  assert.equal(bot.calls.some((c) => c[0] === 'join'), true);
  const status = JSON.parse((await client.callTool({ name: 'status', arguments: {} })).content[0].text);
  assert.equal(status.voice.handed, true);
  assert.equal(status.voice.gap, null);
  await client.close();
});

test('captions are not stored twice, and the bot line is spoken', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-live-'));
  const live = new LiveTranscript(home);
  const id = 'm_abcde12345';
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi', 'notes-test');
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi', 'notes-test');
  const lines = live.tail(id, 0).lines;
  assert.deepEqual(lines.filter((l) => l.kind === 'speech').map((l) => l.speaker + ': ' + l.text), ['Ada: hello', 'Bob: hi']);
  assert.deepEqual(lines.filter((l) => l.kind === 'spoken').map((l) => l.speaker + ': ' + l.text), ['notes-test: echo']);
  live.ingestCaption(id, 'Ada: hello\nnotes-test: echo\nBob: hi\nAda: again', 'notes-test');
  assert.equal(live.tail(id, 0).lines.at(-1).text, 'again');
  assert.equal(live.tail(id, 0).lines.filter((l) => l.kind === 'speech').length, 3);
  assert.equal(live.tail(id, 0).lines.filter((l) => l.kind === 'spoken').length, 1);
});
