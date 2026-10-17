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
const ADMIN = 'owner-key-77';

async function mint(name = 'Demo meeting') {
  const r = json(await call('create_meeting', { name, admin_password: ADMIN }));
  assert.deepEqual(Object.keys(r), ['link']);
  assert.equal(JSON.stringify(r).includes(ADMIN), false);
  const listed = json(await call('list_meetings'));
  const row = listed.meetings.find((m) => m.link === r.link);
  assert.ok(row, 'the minted room is on the meeting list');
  assert.equal(row.topic, name);
  assert.equal('room_password' in row, false);
  assert.equal('admin_password' in row, false);
  return { link: r.link, meeting_id: row.meeting_id, topic: name };
}

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
  assert.deepEqual(names, ['cancel_schedule', 'capacity_status', 'create_meeting', 'end_meeting', 'get_meeting_state', 'get_transcript',
    'import_schedule', 'join_meeting', 'leave_meeting', 'list_meetings', 'list_schedule', 'meeting_status', 'meetings_report',
    'mute', 'raise_hand', 'say', 'schedule_meeting', 'send_chat', 'set_camera', 'set_mic', 'set_voice', 'share_content',
    'snapshot', 'start_meeting', 'status', 'tail_events', 'tail_lines', 'tail_transcript', 'unmute', 'update_schedule']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description && t.description.length > 20, t.name + ' has a description');
  }
  const create = tools.find((t) => t.name === 'create_meeting');
  assert.deepEqual(create.inputSchema.required.slice().sort(), ['admin_password', 'name']);
});

test('create_meeting mints a link on GIFOS_URL and does not touch the browser', async () => {
  const r = await mint('Demo meeting');
  assert.match(r.meeting_id, /^m_[0-9a-f]{10}$/);
  assert.match(r.link, /^http:\/\/127\.0\.0\.1:19510\/run\.html#v=[0-9a-z]{24}$/);
  assert.equal(bot.started, 0);
  assert.equal(bot.calls.length, 0);
  const again = await mint('Other');
  assert.notEqual(again.link, r.link, 'every meeting gets its own room');
  const raw = fs.readFileSync(path.join(home, 'meetings.json'), 'utf8');
  assert.equal(raw.includes(ADMIN), false, 'the admin password is not stored');
});

test('create_meeting adds the relay to the link when GIFOS_RELAY is set', async () => {
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510', GIFOS_RELAY: 'ws://127.0.0.1:19511' });
  await connect();
  const r = await mint();
  assert.match(r.link, /#v=[0-9a-z]{24}&relay=ws%3A%2F%2F127\.0\.0\.1%3A19511$/);
});

test('schemas refuse bad input', async () => {
  const empty = await call('create_meeting', { name: '', admin_password: ADMIN });
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
  const c = await mint();
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
  const c = await mint();
  const m = await call('mute', { meeting_id: c.meeting_id });
  assert.equal(m.isError, true);
  assert.match(text(m), /scheduled\. Call start_meeting first/);
  const t = await call('get_transcript', { meeting_id: c.meeting_id });
  assert.equal(t.isError, true);
});

test('a bot error comes back as a tool error, and the meeting stays scheduled', async () => {
  const c = await mint();
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
  const c = await mint();
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
  const c = await mint();
  await call('start_meeting', { meeting_id: c.meeting_id });
  const r = json(await call('share_content', { meeting_id: c.meeting_id, text: 'Agenda: demo, questions' }));
  assert.equal(r.shared, true);
  assert.deepEqual(bot.calls.at(-1), ['say', 'mt_1', 'Agenda: demo, questions']);
});

test('get_transcript while live, end_meeting keeps a copy, and it survives a restart', async () => {
  const c = await mint();
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
  const a = await mint('First');
  const b = await mint('Second');
  await call('start_meeting', { meeting_id: b.meeting_id });
  const l = json(await call('list_meetings'));
  assert.deepEqual(l.meetings.map((m) => m.meeting_id), [b.meeting_id, a.meeting_id]);
  assert.ok(l.meetings.every((m) => !('transcript' in m) && !('room' in m)), 'no transcript body or bare room in listings');
  const s = json(await call('status'));
  assert.equal(s.gifos_url, 'http://127.0.0.1:19510');
  assert.equal(s.stt_app, 'offline-stt-whisper');
  assert.deepEqual(s.live_meetings, [b.meeting_id]);
  assert.equal(s.bot.state, 'ready');
  assert.equal(s.voice.conversation_voice, 'none');
  assert.equal(s.voice.respond_to_command, true);
  assert.equal(s.voice.handed, false);
  assert.equal(s.voice.model, null);
  assert.match(s.voice.gap, /setVoice/);
  assert.equal(JSON.stringify(s).includes('GIFOS_LLM_KEY'), false);
});

test('say reports the Meet Bot gap and does not post chat', async () => {
  const c = await mint();
  const early = await call('say', { meeting_id: c.meeting_id, text: 'Hello' });
  assert.equal(early.isError, true);
  assert.match(text(early), /start_meeting first/);
  await call('start_meeting', { meeting_id: c.meeting_id });
  const quiet = await call('say', { meeting_id: c.meeting_id, text: 'Hello from the assistant' });
  assert.equal(quiet.isError, true);
  assert.match(text(quiet), /interject/);
  assert.equal(bot.calls.some((row) => row[0] === 'say'), false, 'say does not fall back to meeting chat');
  const switches = json(await call('set_voice', { conversation_voice: 'grok', respond_to_command: false }));
  assert.equal(switches.conversation_voice, 'grok');
  assert.equal(switches.respond_to_command, false);
  assert.equal(switches.handed, false);
  const local = await call('set_voice', { conversation_voice: 'local' });
  assert.equal(local.isError, true);
  assert.match(text(local), /GIFOS_LLM_URL/);
  const tail = json(await call('tail_transcript', { meeting_id: c.meeting_id }));
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.next, 0);
});

test('non-voice tools go through Meet Bot and gaps do not touch chat', async () => {
  const c = await mint();
  await call('start_meeting', { meeting_id: c.meeting_id });
  const chat = json(await call('send_chat', { meeting_id: c.meeting_id, text: 'Hello in chat' }));
  assert.equal(chat.sent, true);
  assert.deepEqual(bot.calls.at(-1), ['say', 'mt_1', 'Hello in chat']);

  const hand = await call('raise_hand', { meeting_id: c.meeting_id, on: true });
  assert.equal(hand.isError, true);
  assert.match(text(hand), /raiseHand/);
  const mic = await call('set_mic', { meeting_id: c.meeting_id, on: true });
  assert.equal(mic.isError, true);
  assert.match(text(mic), /setMic/);
  const cam = await call('set_camera', { meeting_id: c.meeting_id, on: false });
  assert.equal(cam.isError, true);
  assert.match(text(cam), /setCamera/);
  assert.equal(bot.calls.filter((row) => row[0] === 'say').length, 1, 'a gap does not post another chat line');

  bot.people = async (id) => {
    bot.calls.push(['people', id]);
    return [{ name: 'Ada', bot: false, me: false }];
  };
  const state = json(await call('get_meeting_state', { meeting_id: c.meeting_id }));
  assert.equal(state.people[0].name, 'Ada');
  assert.equal(state.hand, null);
  assert.match(state.controls_gap, /meetingState/);
  const shot = json(await call('snapshot', { meeting_id: c.meeting_id }));
  assert.equal(shot.people[0].name, 'Ada');
  assert.match(shot.gap, /snapshot/);
  assert.equal(shot.png, null);

  bot.raiseHand = async (id, on) => {
    bot.calls.push(['raiseHand', id, on]);
    return { applied: true, result: { hand: on } };
  };
  bot.meetingState = async (id) => {
    bot.calls.push(['meetingState', id]);
    return { applied: true, result: { hand: true, mic: false, camera: false } };
  };
  bot.snapshot = async (id) => {
    bot.calls.push(['snapshot', id]);
    return { applied: true, png: home + '/shot.png', result: { id } };
  };
  const up = json(await call('raise_hand', { meeting_id: c.meeting_id, on: true }));
  assert.equal(up.hand, true);
  assert.deepEqual(bot.calls.at(-1), ['raiseHand', 'mt_1', true]);
  const again = json(await call('get_meeting_state', { meeting_id: c.meeting_id }));
  assert.equal(again.controls_gap, null);
  assert.equal(again.hand, true);
  assert.equal(again.mic, false);
  const png = json(await call('snapshot', { meeting_id: c.meeting_id }));
  assert.equal(png.gap, null);
  assert.equal(png.png, home + '/shot.png');

  const left = json(await call('leave_meeting', { meeting_id: c.meeting_id }));
  assert.equal(left.state, 'ended');
  assert.deepEqual(bot.calls.at(-1), ['leave', 'mt_1']);
  const twice = json(await call('leave_meeting', { meeting_id: c.meeting_id }));
  assert.match(twice.note, /not in this meeting/);
});
