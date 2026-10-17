// Stage B: one supervisor, several worker processes. Workers are real forked
// children running the fake Meet Bot in fixtures/fake-worker.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { EventLog } from '../../src/events.js';
import { WorkerPool, splitSession, workerIdentity } from '../../src/pool.js';
import { dropLostMeetings } from '../../src/supervisor.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-worker.js', import.meta.url));
const CREDS = { name: 'notes-stageb', password: 'bot-pass-stage-b-41' };
const ROOM = 'guest-ticket-9';

let home, cfg, pool, thinking;

function makePool(extra = {}) {
  thinking = [];
  pool = new WorkerPool(cfg, CREDS, {
    workers: 2,
    rooms: 2,
    workerScript: FAKE,
    closeMs: 2000,
    onThinking: (id, on) => thinking.push([id, on]),
    ...extra,
  });
  return pool;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-stage-b-'));
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_VOICE: '0', GIFOS_MAX_MEETINGS: '4', GIFOS_CAPACITY_NEAR: '3', GIFOS_WORKERS: '2' });
});

afterEach(async () => {
  if (pool) await pool.close();
  pool = null;
});

test('config: workers and rooms per worker must cover the cap', () => {
  assert.equal(cfg.workers, 2);
  assert.equal(cfg.workerRooms, 2);
  assert.equal(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_VOICE: '0' }).workers, 1);
  assert.throws(() => loadConfig({ GIFOS_MCP_HOME: home, GIFOS_VOICE: '0', GIFOS_MAX_MEETINGS: '6', GIFOS_WORKERS: '2', GIFOS_WORKER_ROOMS: '2' }), /cover GIFOS_MAX_MEETINGS/);
  assert.throws(() => loadConfig({ GIFOS_MCP_HOME: home, GIFOS_VOICE: '0', GIFOS_WORKERS: '0' }), /GIFOS_WORKERS/);
});

test('each worker has its own profile and bot name; worker 0 keeps the original', () => {
  const w0 = workerIdentity(cfg, CREDS, 0);
  const w1 = workerIdentity(cfg, CREDS, 1);
  assert.equal(w0.profile, 'profile-bot');
  assert.equal(w0.creds.name, CREDS.name);
  assert.equal(w1.profile, 'profile-bot-w1');
  assert.equal(w1.creds.name, CREDS.name + '-w1');
  const long = workerIdentity(cfg, { name: 'x'.repeat(40), password: 'p' }, 3);
  assert.equal(long.creds.name.length, 40);
  assert.deepEqual(splitSession('w1:mt_2'), { index: 1, local: 'mt_2' });
  assert.equal(splitSession('mt_2'), null);
});

test('joins fill the warm worker, then start the next; calls stay with the worker that joined', async () => {
  makePool();
  const a = await pool.join('https://gifos.app/run.html#v=roomA', ROOM);
  const b = await pool.join('https://gifos.app/run.html#v=roomB', 'pw-b');
  const c = await pool.join('https://gifos.app/run.html#v=roomC', 'pw-c');
  assert.deepEqual([a, b, c], ['w0:mt_1', 'w0:mt_2', 'w1:mt_1']);
  await pool.say(c, 'hello C');
  await pool.say(a, 'hello A');
  const log0 = await pool.workers[0].call('calls');
  const log1 = await pool.workers[1].call('calls');
  assert.deepEqual(log0.filter((r) => r[0] === 'say'), [['say', 'mt_1', 'hello A']]);
  assert.deepEqual(log1.filter((r) => r[0] === 'say'), [['say', 'mt_1', 'hello C']]);
  assert.deepEqual(log1.find((r) => r[0] === 'join'), ['join', 'https://gifos.app/run.html#v=roomC', 'pw-c']);
  assert.match(await pool.transcript(c), /notes-stageb-w1 mt_1/);
  const info = await pool.info();
  assert.deepEqual(info.workers.map((w) => [w.worker, w.state, w.rooms, w.bot_name]), [[0, 'ready', 2, 'notes-stageb'], [1, 'ready', 1, 'notes-stageb-w1']]);
});

test('a full pool refuses the next join; a leave frees that seat on that worker', async () => {
  makePool();
  const ids = [];
  for (const r of ['a', 'b', 'c', 'd']) ids.push(await pool.join('https://gifos.app/run.html#v=room' + r, ''));
  await assert.rejects(pool.join('https://gifos.app/run.html#v=roome', ''), /Every worker is full/);
  await pool.leave(ids[3]);
  await assert.rejects(pool.say(ids[3], 'gone'), /No worker holds session/);
  const again = await pool.join('https://gifos.app/run.html#v=roome', '');
  assert.equal(splitSession(again).index, 1);
});

test('thinking in a worker is reported under the supervisor session id', async () => {
  makePool();
  await pool.join('https://gifos.app/run.html#v=roomA', '');
  const b = await pool.join('https://gifos.app/run.html#v=roomB', '');
  await pool.workers[0].call('think', 'mt_2', true);
  assert.equal(pool.queue.isThinking(b), true);
  assert.equal(pool.queue.isThinking('w0:mt_1'), false);
  await pool.workers[0].call('think', 'mt_2', false);
  assert.equal(pool.queue.isThinking(b), false);
  assert.deepEqual(thinking, [[b, true], [b, false]]);
});

test('a worker refuses a method that is not on its list, and the bot password is not on its command line or environment', async () => {
  makePool();
  await pool.join('https://gifos.app/run.html#v=roomA', '');
  await assert.rejects(pool.workers[0].call('close'), /no method "close"/);
  const me = await pool.workers[0].call('whoami');
  assert.equal(me.name, CREDS.name);
  assert.equal(me.profile, 'profile-bot');
  assert.equal(me.argv.join(' ').includes(CREDS.password), false);
  assert.deepEqual(me.env, []);
});

test('a worker crash drops its rooms, fails its calls in flight, and the clock rejoins on the worker that is up', async () => {
  const meetings = new MeetingStore(home);
  const events = new EventLog(home);
  let now = Date.now();
  makePool({ now: () => now });
  pool.onLost(dropLostMeetings({ meetings, events }));
  const server = createServer({ cfg, meetings, bot: pool, botName: CREDS.name, events });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(ta), client.connect(tb)]);
  const json = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const links = [];
  for (const name of ['One', 'Two', 'Three']) links.push((await json('create_meeting', { name, admin_password: 'owner-77' })).link);
  const start = new Date(Date.now() - 60 * 1000).toISOString();
  const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (const link of links) await json('schedule_meeting', { link, room_password: ROOM, start, end });
  await server.clock.tick(Date.now());
  const seated = meetings.all().filter((m) => m.state === 'live');
  assert.deepEqual(seated.map((m) => m.session_id).sort(), ['w0:mt_1', 'w0:mt_2', 'w1:mt_1']);

  // Kill worker 1 with a call in flight.
  const inflight = pool.workers[1].call('slow');
  const child = pool.workers[1].child;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  await assert.rejects(inflight, /Worker 1 stopped/);

  const lost = meetings.all().find((m) => m.topic === 'Three');
  assert.equal(lost.state, 'scheduled');
  assert.equal(lost.session_id, null);
  const tail = await json('tail_events');
  assert.ok(tail.events.some((e) => e.type === 'meeting.disconnected' && e.meeting_id === lost.meeting_id && e.data.worker === 1));
  assert.equal((await pool.info()).workers[1].state, 'lost');

  // Worker 0 is full and worker 1 waits out its first backoff, so the next
  // tick leaves the order scheduled. One second later worker 1 starts again
  // and the order, still in its window, is seated there.
  await server.clock.tick(Date.now());
  assert.equal(meetings.get(lost.meeting_id).state, 'scheduled');
  assert.equal((await pool.info()).workers[1].restart_in_ms, 1000);
  now += 1000;
  await server.clock.tick(Date.now());
  const back = meetings.get(lost.meeting_id);
  assert.equal(back.state, 'live');
  assert.equal(back.session_id, 'w1:mt_1');
  const log1 = await pool.workers[1].call('calls');
  assert.deepEqual(log1.find((r) => r[0] === 'join').slice(2), [ROOM]);
  assert.equal(JSON.stringify(tail).includes(ROOM), false);
  await client.close();
});

test('the real worker entry boots over IPC and answers info without starting a browser', async () => {
  cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_VOICE: '0', GIFOS_TTS_ENGINE: 'none', GIFOS_WORKERS: '2' });
  pool = new WorkerPool(cfg, CREDS, { workers: 2, rooms: 2, closeMs: 2000 });
  const inf = await pool.workers[1].call('info');
  assert.equal(inf.state, 'stopped');
  assert.equal(inf.bot_name, CREDS.name + '-w1');
  await assert.rejects(pool.workers[1].call('start'), /no method "start"/);
});

test('a worker that stops answering the heartbeat is killed, and its rooms are dropped', { timeout: 10000 }, async () => {
  makePool({ heartbeatMs: 50, stuckMs: 400 });
  const lost = new Promise((resolve) => pool.onLost((ids, why, index) => resolve({ ids, why, index })));
  const a = await pool.join('https://gifos.app/run.html#v=roomA', '');
  const hung = pool.workers[0].call('hang');
  const got = await lost;
  assert.deepEqual(got, { ids: [a], why: got.why, index: 0 });
  assert.match(got.why, /stopped answering/);
  await assert.rejects(hung, /Worker 0 stopped/);
  const row = (await pool.info()).workers[0];
  assert.equal(row.state, 'lost');
  assert.match(row.error, /stopped answering/);
});

test('a worker that keeps dying waits longer before each restart, and joins go to a worker that is up', async () => {
  const CRASH = fileURLToPath(new URL('./fixtures/crash-worker.js', import.meta.url));
  let now = 1000000;
  const forks = [0, 0];
  makePool({
    now: () => now,
    backoffMs: 1000,
    backoffMaxMs: 4000,
    forkWorker: (index) => {
      forks[index]++;
      return fork(index === 0 ? CRASH : FAKE, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    },
  });
  await assert.rejects(pool.join('https://gifos.app/run.html#v=roomA', ''), /worker 0 exited/);
  assert.deepEqual(forks, [1, 0]);
  // Worker 0 is waiting out its backoff, so the next join starts worker 1.
  assert.equal(await pool.join('https://gifos.app/run.html#v=roomB', ''), 'w1:mt_1');
  assert.equal(await pool.join('https://gifos.app/run.html#v=roomC', ''), 'w1:mt_2');
  assert.deepEqual(forks, [1, 1]);
  // Worker 1 is full and worker 0 may not start yet.
  await assert.rejects(pool.join('https://gifos.app/run.html#v=roomD', ''), /worker 0 restarts in 1s/i);
  assert.deepEqual(forks, [1, 1]);
  assert.equal((await pool.info()).workers[0].restart_in_ms, 1000);
  // 1s, then 2s, then 4s, then capped at 4s.
  for (const wait of [1000, 2000, 4000, 4000]) {
    now += wait - 1;
    await assert.rejects(pool.join('https://gifos.app/run.html#v=roomD', ''), /restarts in/);
    now += 1;
    const before = forks[0];
    await assert.rejects(pool.join('https://gifos.app/run.html#v=roomD', ''), /worker 0 exited/);
    assert.equal(forks[0], before + 1);
  }
});

test('a call that never answers times out without killing a worker that is still alive', { timeout: 10000 }, async () => {
  makePool({ heartbeatMs: 50, stuckMs: 2000, callMs: 200 });
  const a = await pool.join('https://gifos.app/run.html#v=roomA', '');
  const t0 = Date.now();
  await assert.rejects(pool.workers[0].call('slow'), /Worker 0 did not answer slow within 200ms/);
  assert.ok(Date.now() - t0 < 1500);
  // The worker kept answering pings, so it stays up with its room.
  await pool.say(a, 'still here');
  const row = (await pool.info()).workers[0];
  assert.equal(row.state, 'ready');
  assert.equal(row.rooms, 1);
});

test('a join that times out and then lands late is left at once, so no seat is orphaned', { timeout: 10000 }, async () => {
  makePool({ workers: 1, rooms: 1, callMs: 2000, joinMs: 200 });
  await pool.ensureStarted();
  await pool.workers[0].call('holdJoins');
  await assert.rejects(pool.join('https://gifos.app/run.html#v=roomA', ''), /Worker 0 did not answer join within 200ms/);
  assert.equal(pool.workers[0].used, 0);
  await pool.workers[0].call('releaseJoins');
  let log = [];
  for (let i = 0; i < 100 && !log.some((r) => r[0] === 'leave'); i++) {
    await new Promise((r) => setTimeout(r, 20));
    log = await pool.workers[0].call('calls');
  }
  assert.deepEqual(log.filter((r) => r[0] === 'leave'), [['leave', 'mt_1']]);
  // The seat is free for the next join.
  assert.equal(await pool.join('https://gifos.app/run.html#v=roomB', ''), 'w0:mt_2');
});

test('the bot on worker 1 sits as <name>-w1; its own speech is a spoken line, not a human one', async () => {
  const meetings = new MeetingStore(home);
  makePool({ rooms: 1 });
  const server = createServer({ cfg, meetings, bot: pool, botName: CREDS.name });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(ta), client.connect(tb)]);
  const json = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const one = await json('join_meeting', { link: 'https://gifos.app/run.html#v=roomOne' });
  const two = await json('join_meeting', { link: 'https://gifos.app/run.html#v=roomTwo' });
  assert.deepEqual([one, two].map((m) => splitSession(meetings.get(m.meeting_id).session_id).index), [0, 1]);
  for (const m of [one, two]) {
    assert.equal((await json('say', { meeting_id: m.meeting_id, text: 'Hello from the bot' })).spoken, true);
    await client.callTool({ name: 'get_transcript', arguments: { meeting_id: m.meeting_id } });
  }
  for (const [m, name] of [[one, CREDS.name], [two, CREDS.name + '-w1']]) {
    const rows = (await json('tail_lines', { meeting_id: m.meeting_id })).lines;
    assert.deepEqual(rows.filter((l) => l.kind === 'speech').map((l) => l.speaker), ['Ada'], 'human lines in ' + name + "'s room");
    assert.deepEqual(rows.filter((l) => l.kind === 'spoken').map((l) => [l.speaker, l.text]), [[name, 'Hello from the bot']]);
  }
  await client.close();
});
