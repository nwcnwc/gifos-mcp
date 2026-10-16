// Meeting passwords: optional on create/start, seeded into the meeting page,
// stored only in the meetings file, and never returned by a tool.
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
import { MeetingBotDriver } from '../../src/driver.js';

// Built here so a failure diff cannot print it. Proof logs are checked for this value.
const PW = ['k7', 'door', '9q', 'lock'].join('-');

function hidden(got, expected, label) {
  assert.equal(got === expected, true, label);
}
function leaks(obj) {
  const s = JSON.stringify(obj);
  return s.includes(PW) || s.includes('"password"');
}

class FakeBot {
  constructor() { this.calls = []; this.seq = 0; this.started = 0; }
  async ensureStarted() { this.started++; }
  async join(link, password) {
    this.calls.push(['join', link, password]);
    return 'mt_' + (++this.seq);
  }
  async leave() {}
  async transcribe(id, on) { this.calls.push(['transcribe', id, on]); }
  async say() {}
  async transcript() { return ''; }
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
const json = async (name, args) => JSON.parse((await call(name, args)).content[0].text);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-pw-'));
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/' });
  meetings = new MeetingStore(home);
  bot = new FakeBot();
  await connect();
});

test('create_meeting and start_meeting accept an optional password', async () => {
  const { tools } = await client.listTools();
  const create = tools.find((t) => t.name === 'create_meeting');
  const start = tools.find((t) => t.name === 'start_meeting');
  const join = tools.find((t) => t.name === 'join_meeting');
  assert.ok(create.inputSchema.properties.password, 'create_meeting has no password argument');
  assert.equal(create.inputSchema.required.includes('password'), false);
  assert.ok(start.inputSchema.properties.password, 'start_meeting has no password argument');
  assert.equal(start.inputSchema.required.includes('password'), false);
  assert.ok(join.inputSchema.properties.password, 'join_meeting lost its password argument');
});

test('a create password is stored, used by start, and omitted from every tool result', async () => {
  const c = await json('create_meeting', { topic: 'Demo meeting', password: PW });
  assert.equal(bot.started, 0, 'create_meeting must not join');
  assert.equal(leaks(c), false, 'create_meeting returned the password');
  hidden(meetings.get(c.meeting_id).password, PW, 'create_meeting did not store the password');
  assert.equal(c.locked, true);
  const mode = fs.statSync(meetings.file).mode & 0o777;
  assert.equal(mode, 0o600, 'meetings file mode is ' + mode.toString(8));
  assert.equal(fs.readFileSync(meetings.file, 'utf8').includes(PW), true, 'meetings file is missing the password');

  const s = await json('start_meeting', { meeting_id: c.meeting_id });
  assert.equal(s.state, 'live');
  assert.equal(s.locked, true);
  assert.equal(leaks(s), false, 'start_meeting returned the password');
  assert.equal(bot.calls[0][0], 'join');
  assert.equal(bot.calls[0][1], c.link);
  hidden(bot.calls[0][2], PW, 'start_meeting did not pass the stored password to join');

  const listed = await json('list_meetings');
  assert.equal(leaks(listed), false, 'list_meetings returned the password');
  assert.equal(listed.meetings[0].locked, true);
  const status = await json('status');
  assert.equal(leaks(status), false, 'status returned the password');
  assert.deepEqual(status.live_meetings, [c.meeting_id]);
});

test('start_meeting password replaces the stored one', async () => {
  const c = await json('create_meeting', { topic: 'Demo meeting', password: PW });
  const other = PW + '-b';
  const s = await json('start_meeting', { meeting_id: c.meeting_id, password: other });
  assert.equal(leaks(s), false, 'start_meeting returned the password');
  hidden(meetings.get(c.meeting_id).password, other, 'start_meeting did not store the password it was given');
  hidden(bot.calls[0][2], other, 'start_meeting did not pass its password to join');
});

test('join_meeting stores its password and still passes it to the bot', async () => {
  const link = 'https://gifos.app/run.html#v=demoroom123';
  const j = await json('join_meeting', { link, password: PW, topic: 'Guest' });
  assert.equal(j.state, 'live');
  assert.equal(leaks(j), false, 'join_meeting returned the password');
  assert.equal(bot.calls[0][0], 'join');
  assert.equal(bot.calls[0][1], link);
  hidden(bot.calls[0][2], PW, 'join_meeting did not pass the password to join');
  hidden(meetings.get(j.meeting_id).password, PW, 'join_meeting did not store the password');
  assert.equal(j.locked, true);
  const again = await json('join_meeting', { link });
  assert.equal(again.note, 'Already in this meeting.');
  assert.equal(leaks(again), false, 'a second join returned the password');
});

function stubDriver() {
  const driver = new MeetingBotDriver({ passwordModalWaitMs: 0 }, { name: 'notes-test', password: 'unused-bot' });
  const order = [];
  const filled = [];
  driver.state = 'ready';
  driver.bot = {
    app: {
      isClosed: () => false,
      evaluate: async (_fn, arg) => { order.push(['seed', arg]); },
      frames: () => [{
        evaluate: async (_fn, arg) => {
          if (arg == null) return 'join';
          filled.push(arg);
          return true;
        },
      }],
    },
    frame: {
      evaluate: async (_fn, arg) => {
        order.push(['join', arg]);
        return { ok: true, v: { id: 'mt_9' } };
      },
    },
  };
  return { driver, order, filled };
}

test('driver seeds gifos_vpw_<room> before the meeting page loads', async () => {
  const { driver, order } = stubDriver();
  const link = 'https://gifos.app/run.html#v=RoomCode123&av=0123456789abcdef';
  const id = await driver.join(link, PW);
  assert.equal(id, 'mt_9');
  const seedAt = order.findIndex((x) => x[0] === 'seed');
  const joinAt = order.findIndex((x) => x[0] === 'join');
  assert.ok(seedAt >= 0, 'password was not seeded into the meeting page');
  assert.ok(joinAt >= 0, 'MeetingBot.join was not called');
  assert.ok(seedAt < joinAt, 'the password must be seeded before the meeting loads');
  const seed = order[seedAt][1];
  assert.equal(seed.key, 'gifos_vpw_RoomCode123.0123456789abcdef');
  assert.equal(seed.atKey, 'gifos_vpwat_RoomCode123.0123456789abcdef');
  hidden(seed.password, PW, 'seeded value was not the meeting password');
  assert.equal(order[joinAt][1].method, 'join');
  assert.equal(order[joinAt][1].args[0], link);
  hidden(order[joinAt][1].args[1], PW, 'MeetingBot.join did not receive the meeting password');

  const plain = stubDriver();
  await plain.driver.join('https://gifos.app/meet/plain-room', PW);
  const plainSeed = plain.order.find((x) => x[0] === 'seed');
  assert.ok(plainSeed, 'a /meet link was not seeded');
  assert.equal(plainSeed[1].key, 'gifos_vpw_plain-room');
});

test('driver fills the password door modal when it is open', async () => {
  const { driver, filled } = stubDriver();
  await driver.join('https://gifos.app/meet/plain-room', PW);
  assert.equal(filled.length, 1, 'password door modal was not filled');
  hidden(filled[0], PW, 'the door modal was filled with the wrong value');
});
