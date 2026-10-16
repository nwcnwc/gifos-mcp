// Participant host with a fake browser and a fake speech engine. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ParticipantHost } from '../../src/participant/host.js';
import { loadConfig } from '../../src/config.js';
import { MeetingStore } from '../../src/meetings.js';
import { wavFromPcm } from '../../src/audio/wav.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(amp, ms) {
  const n = Math.round(16000 * ms / 1000);
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin(i * 0.4);
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
}

class FakeSession {
  constructor() { this.chats = []; this.plays = []; this.participants = []; this.hand = false; this.mic = true; this.cam = true; }
  async join() { return { coord: '0/0.0' }; }
  async play(_b64, allow) {
    this.plays.push(allow);
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      if (this.ctrl && this.ctrl()) return { interrupted: true, spoken_ms: Date.now() - t0 };
      await sleep(20);
    }
    return { interrupted: false, spoken_ms: 800 };
  }
  async stop() { this.stopped = true; }
  async chat(t) { this.chats.push(t); }
  async setHand(on) { this.hand = on; }
  async setMic(on) { this.mic = on; }
  async setCam(on) { this.cam = on; }
  async state() { return { participants: this.participants.slice(), hand: this.hand, mic: this.mic, cam: this.cam, chat: this.chats.slice() }; }
  async stats() { return { rms: 0 }; }
  async leave() {}
  async close() { this.closed = true; }
}

function setup(heard) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-part-'));
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:9', GIFOS_TURN_PAUSE_MS: '50' });
  const meetings = new MeetingStore(home);
  let session;
  const stt = { id: 'fake', async transcribe(wav) { heard.push(wav); return { text: heard.text || 'the purple giraffe reads seven books', ms: 1 }; }, async close() {} };
  const tts = { async synthesize() { return wavFromPcm(new Int16Array(160), 16000, 1); } };
  const host = new ParticipantHost(cfg, meetings, () => (session = new FakeSession()), { stt: () => stt, tts: () => tts });
  return { host, meetings, get session() { return session; }, stt };
}

async function speak(host, name, streamId) {
  let t = Date.now();
  for (let i = 0; i < 4; i++) {
    t += 100;
    host.onFrame({ streamId, name, b64: frame(0.2, 100) });
  }
  for (let i = 0; i < 5; i++) {
    t += 100;
    host.onFrame({ streamId, name, b64: frame(0, 100) });
  }
}

test('each remote stream is attributed to that person, and our own name is ignored', async () => {
  const heard = [];
  const { host } = setup(heard);
  await host.join({ url: 'https://gifos.app/run.html#v=room-one', display_name: 'Helper' });
  assert.equal(host.displayName, 'Helper 🤖');
  await speak(host, 'Ada', 'stream-ada');
  await speak(host, 'Helper 🤖', 'stream-me');
  const got = await host.utterances({ wait_ms: 1000 });
  assert.equal(got.utterances.length, 1);
  assert.equal(got.utterances[0].speaker, 'Ada');
  assert.match(got.utterances[0].text, /purple giraffe/);
  assert.equal(typeof got.utterances[0].t_start, 'number');
  assert.ok(got.utterances[0].t_end >= got.utterances[0].t_start);
  const again = await host.utterances({ since: got.utterances[0].id, wait_ms: 0 });
  assert.equal(again.utterances.length, 0);
  assert.equal(again.state.turn_hint, 'wait', 'the pause has not happened yet');
  await sleep(80);
  const later = await host.utterances({ since: got.utterances[0].id, wait_ms: 0 });
  assert.equal(later.state.turn_hint, 'your_turn');
  await host.leave();
});

test('a silence hallucination is not delivered', async () => {
  const heard = [];
  heard.text = 'Thank you.';
  const { host } = setup(heard);
  await host.join({ url: 'https://gifos.app/run.html#v=room-two', display_name: 'Helper' });
  await speak(host, 'Ada', 'stream-ada');
  await sleep(50);
  const got = await host.utterances({ wait_ms: 200 });
  assert.equal(got.utterances.length, 0);
  await host.leave();
});

test('say can be interrupted, and stop_speaking asks the page to cut playback', async () => {
  const env = setup([]);
  await env.host.join({ url: 'https://gifos.app/meet/room-three', display_name: 'Helper' });
  const pending = env.host.say('a long sentence that should be cut off now', '', true);
  await sleep(40);
  const stopped = await env.host.stop();
  assert.equal(stopped.stopped, true);
  const said = await pending;
  assert.equal(said.interrupted, true);
  assert.ok(said.spoken_until_ms < 800);
  assert.equal(env.session.plays[0], true);
  await env.host.leave();
});

test('leave ends the meeting record and closes the page', async () => {
  const env = setup([]);
  const joined = await env.host.join({ url: 'https://gifos.app/run.html#v=room-four', display_name: 'Helper' });
  assert.equal(env.meetings.get(joined.meeting_id).mode, 'participant');
  assert.equal(env.meetings.get(joined.meeting_id).state, 'live');
  const left = await env.host.leave();
  assert.equal(left.left, true);
  assert.equal(env.meetings.get(joined.meeting_id).state, 'ended');
  assert.equal(env.session.closed, true);
  await assert.rejects(() => env.host.meetingState(), /Not in a meeting/);
});
