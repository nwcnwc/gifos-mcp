// Room password is listed for the guest to type. It is never inside a link.
// The admin password is never in an invite, a transcript, or any tool result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { formatInvite, plainLink, urlsOf, PASSWORD_LINK_NOTE } from '../../src/invite.js';

const ADMIN = 'HarborNorth77';
const ROOM = 'guest-ticket-9';

function urlsContain(text, secret) {
  return urlsOf(text).some((u) => u.includes(secret));
}

test('an invite lists the room password beside a plain link', () => {
  const link = 'https://gifos.app/run.html#v=demoroom123&password=' + ROOM + '&pw=' + ROOM;
  const invite = formatInvite({ topic: 'Demo', link, roomPassword: ROOM, startTime: '17:00' });
  assert.equal(urlsContain(invite.email, ROOM), false);
  assert.equal(urlsContain(JSON.stringify(invite.calendar), ROOM), false);
  assert.match(invite.email, new RegExp(ROOM));
  assert.match(invite.calendar.description, new RegExp(ROOM));
  assert.equal(invite.calendar.url.includes(ROOM), false);
  assert.equal(invite.link.includes('password='), false);
  assert.match(invite.email, /type this yourself/);
  assert.match(invite.email, /Paid one-click links/);
  assert.equal(invite.email.includes(ADMIN), false);
  assert.equal(JSON.stringify(invite).includes(ADMIN), false);
  assert.equal(PASSWORD_LINK_NOTE.includes('http'), false);
});

test('a link that is the password itself is refused', () => {
  assert.throws(() => plainLink('https://gifos.app/run.html#v=' + ROOM, ROOM), /must not contain the room password/);
});

test('tool output carries the room password only as its own field, and never the admin password', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-inv-'));
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/' });
  const meetings = new MeetingStore(home);
  const bot = {
    calls: [],
    lines: {},
    seq: 0,
    async ensureStarted() {},
    async join(link, password) {
      this.calls.push(['join', link, password]);
      const id = 'mt_' + (++this.seq);
      this.lines[id] = ['Ada: the code is ' + ADMIN];
      return id;
    },
    async transcribe() {},
    async transcript(id) { return (this.lines[id] || []).join('\n'); },
    async leave() {},
    async info() { return { state: 'ready', bot_name: 'notes-test', password: ADMIN }; },
  };
  const server = createServer({ cfg, meetings, bot, participant: null, adminPassword: ADMIN });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const created = JSON.parse((await client.callTool({
    name: 'create_meeting',
    arguments: { topic: 'Demo', room_password: ROOM },
  })).content[0].text);
  assert.equal(urlsContain(created.invite_email, ROOM), false);
  assert.equal(urlsContain(JSON.stringify(created.invite_calendar), ROOM), false);
  assert.match(created.invite_email, new RegExp(ROOM));
  assert.equal(created.link.includes(ROOM), false);
  assert.equal(JSON.stringify(created).includes(ADMIN), false);
  assert.match(created.password_links, /not available/);

  const started = JSON.parse((await client.callTool({
    name: 'start_meeting',
    arguments: { meeting_id: created.meeting_id },
  })).content[0].text);
  assert.equal(started.link.includes(ROOM), false);
  assert.equal(JSON.stringify(started).includes(ADMIN), false);
  assert.equal(bot.calls[0][1].includes(ROOM), false, 'the bot is handed a plain link');

  const dirty = 'https://gifos.app/run.html#v=otherroom1&password=' + ROOM;
  const joined = JSON.parse((await client.callTool({
    name: 'join_meeting',
    arguments: { link: dirty, password: ROOM },
  })).content[0].text);
  assert.equal(joined.link.includes('password='), false);
  assert.equal(joined.link.includes(ROOM), false);
  assert.equal(bot.calls[1][1].includes(ROOM), false);

  const transcript = (await client.callTool({
    name: 'get_transcript',
    arguments: { meeting_id: created.meeting_id },
  })).content[0].text;
  assert.equal(transcript.includes(ADMIN), false);
  assert.match(transcript, /\[redacted\]/);

  const status = (await client.callTool({ name: 'status', arguments: {} })).content[0].text;
  assert.equal(status.includes(ADMIN), false);
  assert.match(status, /\[redacted\]/);
});
