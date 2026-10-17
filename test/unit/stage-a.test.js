// Stage A tools over the MCP server: schedule, capacity, lines, events, thinking.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { tmpHome } from './fixtures/tmp-home.js';

const ADMIN = 'owner-key-77';
const ROOM = 'guest-ticket-9';

class FakeBot {
  constructor() { this.calls = []; this.lines = {}; this.seq = 0; this.peopleList = [{ name: 'Ada', bot: false }]; }
  async ensureStarted() {}
  async join(link, password) {
    this.calls.push(['join', link, password]);
    const id = 'mt_' + (++this.seq);
    this.lines[id] = [];
    return id;
  }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe(id, on) { this.calls.push(['transcribe', id, on]); }
  async say(id, text) { this.calls.push(['say', id, text]); }
  async interject(id, text) { this.calls.push(['interject', id, text]); return { applied: true }; }
  async transcript(id) { return (this.lines[id] || []).join('\n'); }
  async people() { return this.peopleList; }
  async info() { return { state: 'ready', bot_name: 'notes-test' }; }
}

let home, cfg, meetings, bot, client, server;

async function connect() {
  server = createServer({ cfg, meetings, bot, botName: 'notes-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
}
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const json = async (name, args) => JSON.parse((await call(name, args)).content[0].text);

beforeEach(async () => {
  home = tmpHome('gifos-stage-a-');
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_VOICE: '0', GIFOS_MAX_MEETINGS: '2', GIFOS_CAPACITY_NEAR: '1' });
  meetings = new MeetingStore(home);
  bot = new FakeBot();
  await connect();
});

async function mint(name = 'Notes') {
  const created = await json('create_meeting', { name, admin_password: ADMIN });
  assert.deepEqual(Object.keys(created), ['link']);
  const listed = await json('list_meetings');
  return { link: created.link, meeting_id: listed.meetings.find((m) => m.link === created.link).meeting_id };
}

test('create_meeting, schedule_meeting, list, update, import, and cancel', async () => {
  const room = await mint('Notes');
  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const scheduled = await json('schedule_meeting', { link: room.link, room_password: ROOM, start, end, topic: 'Notes' });
  assert.equal(scheduled.phase, 'upcoming');
  assert.equal(JSON.stringify(scheduled).includes(ROOM), false);
  assert.equal(JSON.stringify(scheduled).includes(ADMIN), false);
  assert.match(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8'), new RegExp(ROOM));
  assert.equal(fs.readFileSync(path.join(home, 'meetings.json'), 'utf8').includes(ADMIN), false);
  assert.equal(fs.readFileSync(path.join(home, 'meetings.json'), 'utf8').includes(ROOM), false);

  const listed = await json('list_schedule', { timezone: 'UTC' });
  assert.equal(listed.orders.length, 1);
  assert.equal(listed.orders[0].schedule_id, scheduled.schedule_id);
  assert.ok(listed.orders[0].local_start);

  const updated = await json('update_schedule', { schedule_id: scheduled.schedule_id, topic: 'Notes renamed' });
  assert.equal(updated.topic, 'Notes renamed');

  const imported = await json('import_schedule', {
    orders: [
      { link: room.link, room_password: ROOM, start, end, external_id: 'cal-1', topic: 'Imported' },
      { link: 'https://gifos.app/run.html#v=otherroom', room_password: ROOM, start, end, external_id: 'cal-bad', recurrence: 'not a rule' },
    ],
  });
  assert.equal(imported.conflicts.some((row) => row.reason === 'rule' && row.external_id === 'cal-bad'), true);
  assert.equal(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8').includes('not a rule'), false);

  const cancelled = await json('cancel_schedule', { schedule_id: scheduled.schedule_id, leave_if_live: false });
  assert.equal(cancelled.cancelled[0].phase, 'cancelled');
  const events = await json('tail_events', { since: 0 });
  assert.ok(events.events.some((row) => row.type === 'schedule.created'));
  assert.ok(events.events.some((row) => row.type === 'schedule.cancelled'));
  assert.equal(JSON.stringify(events).includes(ROOM), false);
  assert.equal(JSON.stringify(events).includes(ADMIN), false);
});

test('the clock joins with the stored room password and capacity_status reports a clash', async () => {
  const a = await mint('Notes');
  const b = await mint('Review');
  const start = new Date(Date.now() + 30 * 1000).toISOString();
  const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await json('schedule_meeting', { link: a.link, room_password: ROOM, start, end });
  const second = await json('schedule_meeting', { link: b.link, room_password: 'other-secret-2', start, end });
  assert.ok(second.capacity.over_by >= 1 || second.capacity.seated_at_start >= 1);
  const picture = await json('capacity_status');
  assert.ok(picture.level === 'near' || picture.level === 'reached');
  await server.clock.tick(Date.parse(start) - 20 * 1000);
  assert.equal(bot.calls.filter((row) => row[0] === 'join').length, 2);
  assert.equal(bot.calls[0][2], ROOM);
  assert.equal(bot.calls[2][2], 'other-secret-2');
  const events = await json('tail_events');
  assert.ok(events.events.some((row) => row.type === 'meeting.joined'));
  const status = await json('meeting_status', { meeting_id: a.meeting_id });
  assert.equal(status.state, 'live');
  assert.equal(status.phase, 'live');
  assert.equal(status.people[0].name, 'Ada');
  assert.equal(JSON.stringify(status).includes(ROOM), false);
});

test('lines, report, thinking, overrun, and a full room', async () => {
  const room = await mint('Notes');
  await call('start_meeting', { meeting_id: room.meeting_id });
  const chat = await json('send_chat', { meeting_id: room.meeting_id, text: 'hello in chat' });
  assert.equal(chat.sent, true);
  const said = await json('say', { meeting_id: room.meeting_id, text: 'I will take that.' });
  assert.equal(said.spoken, true);
  const lines = await json('tail_lines', { meeting_id: room.meeting_id, kinds: ['chat', 'spoken'] });
  assert.deepEqual(lines.lines.map((row) => row.kind), ['chat', 'spoken']);
  const report = await json('meetings_report', { meeting_ids: [room.meeting_id] });
  assert.equal(report.meetings[0].counts.chat, 1);
  assert.equal(report.meetings[0].counts.spoken, 1);

  meetings.update(room.meeting_id, { thinking: true });
  const thinking = await json('meeting_status', { meeting_id: room.meeting_id });
  assert.equal(thinking.thinking, true);

  cfg.maxMeetings = 1;
  const refused = await call('join_meeting', { link: 'https://gifos.app/run.html#v=thirdroom', password: ROOM });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /at capacity/);

  const start = new Date(Date.now() - 60 * 1000).toISOString();
  const endMs = Date.now() + 60 * 1000;
  const scheduled = await json('schedule_meeting', {
    link: room.link, room_password: ROOM, start, end: new Date(endMs).toISOString(), topic: 'Notes',
  });
  await server.clock.tick(Date.now());
  bot.peopleList = [{ name: 'Bot', bot: true }];
  await server.clock.tick(endMs + 1000);
  const after = await json('list_schedule');
  const row = after.orders.find((o) => o.schedule_id === scheduled.schedule_id);
  assert.equal(row.phase, 'ended');
  assert.ok(bot.calls.some((entry) => entry[0] === 'leave'));
});

// Meet Bot drops a room on its own when someone ends it from the admin
// meeting or the Meet Bot page; its end then rejects "No such meeting".
test('leave_meeting on a room Meet Bot already dropped ends the meeting and keeps its transcript', async () => {
  const room = await mint('Notes');
  await call('start_meeting', { meeting_id: room.meeting_id });
  const live = meetings.get(room.meeting_id);
  bot.lines[live.session_id] = ['Ada: last words'];
  bot.leave = async (id) => { throw new Error('Meeting Bot: No such meeting: ' + id); };
  const left = await call('leave_meeting', { meeting_id: room.meeting_id });
  assert.notEqual(left.isError, true, left.content[0].text);
  const after = meetings.get(room.meeting_id);
  assert.equal(after.state, 'ended');
  assert.equal(after.session_id, null);
  assert.match(after.transcript, /last words/);
});

test('end_meeting that fails for another reason keeps the meeting live so a retry can reach it', async () => {
  const room = await mint('Notes');
  await call('start_meeting', { meeting_id: room.meeting_id });
  const sessionId = meetings.get(room.meeting_id).session_id;
  const leave = bot.leave.bind(bot);
  bot.leave = async () => { throw new Error('Meeting Bot: page is busy'); };
  const failed = await call('end_meeting', { meeting_id: room.meeting_id });
  assert.equal(failed.isError, true);
  assert.equal(meetings.get(room.meeting_id).state, 'live');
  bot.leave = leave;
  const retried = await call('end_meeting', { meeting_id: room.meeting_id });
  assert.notEqual(retried.isError, true, retried.content[0].text);
  assert.equal(meetings.get(room.meeting_id).state, 'ended');
  assert.deepEqual(bot.calls.filter((row) => row[0] === 'leave').pop(), ['leave', sessionId]);
});

test('the clock ends an overrun room Meet Bot already dropped and still serves the next order', async () => {
  const a = await mint('Notes');
  const b = await mint('Review');
  const startA = new Date(Date.now() - 60 * 1000).toISOString();
  const endA = Date.now() + 60 * 1000;
  const first = await json('schedule_meeting', { link: a.link, room_password: ROOM, start: startA, end: new Date(endA).toISOString() });
  await server.clock.tick(Date.now());
  // The second order becomes due only at the tick after the first overruns.
  const startB = new Date(endA + 30 * 1000).toISOString();
  const second = await json('schedule_meeting', { link: b.link, room_password: ROOM, start: startB, end: new Date(endA + 60 * 60 * 1000).toISOString() });
  bot.peopleList = [{ name: 'Bot', bot: true }];
  bot.leave = async (id) => { throw new Error('Meeting Bot: No such meeting: ' + id); };
  await server.clock.tick(endA + 1000);
  const rows = (await json('list_schedule')).orders;
  assert.equal(rows.find((o) => o.schedule_id === first.schedule_id).phase, 'ended');
  assert.equal(meetings.get(a.meeting_id).state, 'ended');
  assert.equal(rows.find((o) => o.schedule_id === second.schedule_id).phase, 'live');
});

// Any other leave failure (a busy page, a timed-out call) keeps the room
// live for the next tick, but must not stop the tick serving later orders.
test('a clock leave that fails for another reason still serves the next order and retries the leave next tick', async () => {
  const a = await mint('Notes');
  const b = await mint('Review');
  const startA = new Date(Date.now() - 60 * 1000).toISOString();
  const endA = Date.now() + 60 * 1000;
  const first = await json('schedule_meeting', { link: a.link, room_password: ROOM, start: startA, end: new Date(endA).toISOString() });
  await server.clock.tick(Date.now());
  const startB = new Date(endA + 30 * 1000).toISOString();
  const second = await json('schedule_meeting', { link: b.link, room_password: ROOM, start: startB, end: new Date(endA + 60 * 60 * 1000).toISOString() });
  bot.peopleList = [{ name: 'Bot', bot: true }];
  const leave = bot.leave.bind(bot);
  bot.leave = async () => { throw new Error('Meeting Bot: page is busy'); };
  await assert.doesNotReject(server.clock.tick(endA + 1000));
  let rows = (await json('list_schedule')).orders;
  assert.equal(meetings.get(a.meeting_id).state, 'live');
  assert.equal(rows.find((o) => o.schedule_id === first.schedule_id).phase, 'overrun');
  assert.equal(rows.find((o) => o.schedule_id === second.schedule_id).phase, 'live');
  // One error event for the failed leave, not one per tick.
  await server.clock.tick(endA + 2000);
  const errors = (await json('tail_events', { since: 0 })).events.filter((row) => row.type === 'meeting.error' && row.meeting_id === a.meeting_id);
  assert.equal(errors.length, 1);
  bot.leave = leave;
  await server.clock.tick(endA + 3000);
  rows = (await json('list_schedule')).orders;
  assert.equal(meetings.get(a.meeting_id).state, 'ended');
  assert.equal(rows.find((o) => o.schedule_id === first.schedule_id).phase, 'ended');
});
