// The admin room is derived from the bot name and password, then spoken
// as gb1 chat. The password itself is not a field of the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAdmin, encode, decode } from '../../src/admin/proto.js';
import { AdminRoom } from '../../src/admin/room.js';

test('the same name and password always derive the same admin room', () => {
  const a = deriveAdmin('harbor-north', 'steady-maple-42');
  const b = deriveAdmin('harbor-north', 'steady-maple-42');
  assert.deepEqual(a, b);
  assert.match(a.room, /^[0-9a-f]{32}$/);
  assert.match(a.password, /^[0-9a-f]{32}$/);
  assert.notEqual(a.room, a.password);
  const other = deriveAdmin('harbor-north', 'steady-maple-43');
  assert.notEqual(other.room, a.room);
});

test('controller commands round-trip and a mismatched reply is refused', async () => {
  const wire = encode({ role: 'controller', op: 'join', id: 'q1', link: 'https://gifos.app/run.html#v=abc' });
  const back = decode(wire);
  assert.equal(back.op, 'join');
  assert.equal(decode('hello'), null);
  assert.equal(decode('gb1 {"v":1,"op":"list"}'), null);

  const sent = [];
  const room = new AdminRoom(async (msg) => {
    sent.push(msg);
    assert.equal(msg.role, 'controller');
    assert.equal(msg.adminPassword, undefined);
    return { v: 1, role: 'bot', op: 'ok', ref: msg.id, meetingId: 'mt_9' };
  });
  const reply = await room.call('join', { link: 'https://gifos.app/run.html#v=abc', password: 'guest-ticket-9' });
  assert.equal(reply.meetingId, 'mt_9');
  assert.equal(sent[0].password, 'guest-ticket-9');
  assert.equal(sent[0].adminPassword, undefined);

  const deaf = new AdminRoom(async (msg) => ({ v: 1, role: 'bot', op: 'ok', ref: 'other', meetingId: 'mt_0' }));
  await assert.rejects(() => deaf.call('list', {}), /different command/);

  const old = new AdminRoom(async () => ({ v: 1, role: 'bot', op: 'err', ref: 'q1', text: 'Unknown command.' }));
  await assert.rejects(() => old.call('providers', { roles: [] }), (e) => e.unknown === true);
});
