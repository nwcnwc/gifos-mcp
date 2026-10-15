// Tool schemas and handlers over a real MCP client/server pair, with the
// browser replaced by a fake bot that records what it was asked to do.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';

class FakeBot {
  constructor() { this.calls = []; this.lines = {}; this.seq = 0; this.started = 0; this.failJoin = ''; }
  async ensureStarted() { this.started++; }
  async join(link, password) {
    this.calls.push(['join', link, password]);
    if (this.failJoin) throw new Error(this.failJoin);
    const id = 'mt_' + (++this.seq);
    this.lines[id] = [];
    return id;
  }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe(id, on) { this.calls.push(['transcribe', id, on]); }
  async say(id, text) { this.calls.push(['say', id, text]); }
  async transcript(id) { this.calls.push(['transcript', id]); return (this.lines[id] || []).join('\n'); }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
}

let home, cfg, meetings, bot, client;

async function connect() {
  const server = createServer({ cfg, meetings, bot });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
}
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content[0].text;
const json = (r) => JSON.parse(text(r));

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-unit-'));
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/' });
  meetings = new MeetingStore(home);
  bot = new FakeBot();
  await connect();
});

test('lists every tool with an input schema', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['create_meeting', 'end_meeting', 'get_transcript', 'join_meeting', 'list_meetings',
    'mute', 'share_content', 'start_meeting', 'status', 'unmute']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description && t.description.length > 20, t.name + ' has a description');
  }
  const create = tools.find((t) => t.name === 'create_meeting');
  assert.deepEqual(create.inputSchema.required, ['topic']);
  assert.ok(create.inputSchema.properties.start_time);
});

test('create_meeting mints a link on GIFOS_URL and does not touch the browser', async () => {
  const r = json(await call('create_meeting', { topic: 'Demo meeting', start_time: '2026-10-15T17:00:00-07:00' }));
  assert.match(r.meeting_id, /^m_[0-9a-f]{10}$/);
  assert.match(r.link, /^http:\/\/127\.0\.0\.1:19510\/run\.html#v=[0-9a-z]{24}$/);
  assert.equal(r.topic, 'Demo meeting');
  assert.equal(r.start_time, '2026-10-15T17:00:00-07:00');
  assert.equal(bot.started, 0);
  assert.equal(bot.calls.length, 0);
  const again = json(await call('create_meeting', { topic: 'Other' }));
  assert.notEqual(again.link, r.link, 'every meeting gets its own room');
});

test('create_meeting adds the relay to the link when GIFOS_RELAY is set', async () => {
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510', GIFOS_RELAY: 'ws://127.0.0.1:19511' });
  await connect();
  const r = json(await call('create_meeting', { topic: 'Demo meeting' }));
  assert.match(r.link, /#v=[0-9a-z]{24}&relay=ws%3A%2F%2F127\.0\.0\.1%3A19511$/);
});

test('schemas refuse bad input', async () => {
  const empty = await call('create_meeting', { topic: '' });
  assert.equal(empty.isError, true);
  const missing = await call('create_meeting', {});
  assert.equal(missing.isError, true);
  const notUrl = await call('join_meeting', { link: 'not a link' });
  assert.equal(notUrl.isError, true);
  const noText = await call('share_content', { meeting_id: 'm_0000000000', text: '' });
  assert.equal(noText.isError, true);
  assert.equal(bot.calls.length, 0);
});

test('start_meeting joins the link and turns transcription on', async () => {
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  const s = json(await call('start_meeting', { meeting_id: c.meeting_id }));
  assert.equal(s.state, 'live');
  assert.equal(s.transcribing, true);
  assert.deepEqual(bot.calls, [['join', c.link, ''], ['transcribe', 'mt_1', true]]);
  const again = json(await call('start_meeting', { meeting_id: c.meeting_id }));
  assert.equal(again.note, 'Already live.');
  assert.equal(bot.calls.length, 2, 'a second start does not join twice');
});

test('unknown meeting ids and meetings that are not live are explained', async () => {
  const r = await call('start_meeting', { meeting_id: 'm_ffffffffff' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Unknown meeting_id/);
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  const m = await call('mute', { meeting_id: c.meeting_id });
  assert.equal(m.isError, true);
  assert.match(text(m), /scheduled\. Call start_meeting first/);
  const t = await call('get_transcript', { meeting_id: c.meeting_id });
  assert.equal(t.isError, true);
});

test('a bot error comes back as a tool error, and the meeting stays scheduled', async () => {
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  bot.failJoin = 'Meeting Bot: could not join';
  const r = await call('start_meeting', { meeting_id: c.meeting_id });
  assert.equal(r.isError, true);
  assert.match(text(r), /could not join/);
  assert.equal(meetings.get(c.meeting_id).state, 'scheduled');
});

test('join_meeting accepts run.html and /meet links, refuses others', async () => {
  const a = json(await call('join_meeting', { link: 'https://gifos.app/run.html#v=demoroom123&av=1', password: 'pw' }));
  assert.equal(a.state, 'live');
  assert.deepEqual(bot.calls[0], ['join', 'https://gifos.app/run.html#v=demoroom123&av=1', 'pw']);
  const b = json(await call('join_meeting', { link: 'https://gifos.app/meet/another-room' }));
  assert.equal(b.state, 'live');
  assert.notEqual(a.meeting_id, b.meeting_id);
  const same = json(await call('join_meeting', { link: 'https://gifos.app/run.html#v=demoroom123' }));
  assert.equal(same.meeting_id, a.meeting_id, 'the same room is the same meeting');
  assert.equal(same.note, 'Already in this meeting.');
  const bad = await call('join_meeting', { link: 'https://example.com/somewhere' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /not a GifOS meeting link/);
});

test('mute and unmute switch transcription', async () => {
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  await call('start_meeting', { meeting_id: c.meeting_id });
  const m = json(await call('mute', { meeting_id: c.meeting_id }));
  assert.equal(m.muted, true);
  assert.equal(m.transcribing, false);
  const u = json(await call('unmute', { meeting_id: c.meeting_id }));
  assert.equal(u.muted, false);
  assert.equal(u.transcribing, true);
  assert.deepEqual(bot.calls.slice(2), [['transcribe', 'mt_1', false], ['transcribe', 'mt_1', true]]);
});

test('share_content posts into the meeting', async () => {
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  await call('start_meeting', { meeting_id: c.meeting_id });
  const r = json(await call('share_content', { meeting_id: c.meeting_id, text: 'Agenda: demo, questions' }));
  assert.equal(r.shared, true);
  assert.deepEqual(bot.calls.at(-1), ['say', 'mt_1', 'Agenda: demo, questions']);
});

test('get_transcript while live, end_meeting keeps a copy, and it survives a restart', async () => {
  const c = json(await call('create_meeting', { topic: 'Demo meeting' }));
  await call('start_meeting', { meeting_id: c.meeting_id });
  assert.equal(text(await call('get_transcript', { meeting_id: c.meeting_id })), '(no transcript lines yet)');
  bot.lines.mt_1.push('Alice: hello everyone', 'Bob: hi Alice');
  assert.equal(text(await call('get_transcript', { meeting_id: c.meeting_id })), 'Alice: hello everyone\nBob: hi Alice');
  const e = json(await call('end_meeting', { meeting_id: c.meeting_id }));
  assert.equal(e.state, 'ended');
  assert.equal(e.transcript_lines, 2);
  assert.deepEqual(bot.calls.at(-1), ['leave', 'mt_1']);
  bot.lines.mt_1.push('Alice: after the bot left');
  assert.equal(text(await call('get_transcript', { meeting_id: c.meeting_id })), 'Alice: hello everyone\nBob: hi Alice');
  const fresh = new MeetingStore(home);
  assert.equal(fresh.get(c.meeting_id).transcript, 'Alice: hello everyone\nBob: hi Alice');
  const twice = json(await call('end_meeting', { meeting_id: c.meeting_id }));
  assert.match(twice.note, /not in this meeting/);
});

test('list_meetings and status', async () => {
  const a = json(await call('create_meeting', { topic: 'First' }));
  const b = json(await call('create_meeting', { topic: 'Second' }));
  await call('start_meeting', { meeting_id: b.meeting_id });
  const l = json(await call('list_meetings'));
  assert.deepEqual(l.meetings.map((m) => m.meeting_id), [b.meeting_id, a.meeting_id]);
  assert.ok(l.meetings.every((m) => !('transcript' in m) && !('room' in m)), 'no transcript body or bare room in listings');
  const s = json(await call('status'));
  assert.equal(s.gifos_url, 'http://127.0.0.1:19510');
  assert.equal(s.stt_app, 'offline-stt-whisper');
  assert.deepEqual(s.live_meetings, [b.meeting_id]);
  assert.equal(s.bot.state, 'ready');
});
