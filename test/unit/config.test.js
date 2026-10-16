import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, botCredentials, credentialProblem, generateCredentials, DEFAULT_GIFOS_URL, voiceConfig, voicePublic, SUGGESTED_LLM_URL, SUGGESTED_LLM_MODEL } from '../../src/config.js';
import { MeetingStore, newRoom, linkFor, roomFromLink } from '../../src/meetings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-cfg-'));

test('defaults', () => {
  const c = loadConfig({ GIFOS_MCP_HOME: '/x' });
  assert.equal(c.gifosUrl, DEFAULT_GIFOS_URL);
  assert.equal(c.sttApp, 'offline-stt-whisper');
  assert.equal(c.headless, true);
  assert.equal(c.relay, '');
  assert.equal(c.timeoutMs, 120000);
  assert.equal(loadConfig({ GIFOS_STT_APP: 'none' }).sttApp, '');
  assert.equal(loadConfig({ GIFOS_URL: 'http://127.0.0.1:19510///' }).gifosUrl, 'http://127.0.0.1:19510');
  assert.throws(() => loadConfig({ GIFOS_URL: 'gifos.app' }), /GIFOS_URL/);
});

test('meeting voice uses the caller key and the suggested xAI model', () => {
  const off = voiceConfig({ GIFOS_MCP_HOME: '/x' });
  assert.equal(off.enabled, false);
  assert.equal(off.url, '');
  assert.deepEqual(voicePublic(off), { speaking: false, model: null });
  const suggested = voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key' });
  assert.equal(suggested.enabled, true);
  assert.equal(suggested.url, SUGGESTED_LLM_URL);
  assert.equal(suggested.model, SUGGESTED_LLM_MODEL);
  assert.equal(suggested.ttsPath, '/tts');
  assert.equal(suggested.key, 'sk-test-key');
  assert.equal(JSON.stringify(voicePublic(suggested)).includes('sk-test-key'), false);
  assert.equal(JSON.stringify(voicePublic(suggested)).includes('api.x.ai'), false);
  const local = voiceConfig({ GIFOS_LLM_URL: 'http://127.0.0.1:9/v1/', GIFOS_LLM_MODEL: 'local-model' });
  assert.equal(local.enabled, true);
  assert.equal(local.url, 'http://127.0.0.1:9/v1');
  assert.equal(local.ttsPath, '/audio/speech');
  assert.equal(local.model, 'local-model');
  assert.equal(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_VOICE: '0' }).enabled, false);
  assert.equal(voiceConfig({ GIFOS_LLM_URL: 'http://127.0.0.1:9/v1' }).enabled, false);
  assert.throws(() => voiceConfig({ GIFOS_LLM_URL: 'not a url' }), /GIFOS_LLM_URL/);
});

test('credential rules match the Meeting Bot app', () => {
  assert.match(credentialProblem('bot', 'bot'), /less obvious/);
  assert.match(credentialProblem('harbor-maple', 'short1'), /10 characters/);
  assert.match(credentialProblem('harbor-maple', 'harbor-maple'), /not be the name/);
  assert.match(credentialProblem('harbor-maple', 'abcdefghijk'), /letter and a digit/);
  assert.equal(credentialProblem('harbor-maple', 'quiet-cedar-42'), '');
  for (let i = 0; i < 50; i++) {
    const g = generateCredentials();
    assert.equal(credentialProblem(g.name, g.password), '', JSON.stringify(g));
  }
});

test('generated credentials persist with mode 0600; env wins and is checked', () => {
  const home = tmp();
  const a = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
  assert.equal(a.source, 'generated');
  const st = fs.statSync(path.join(home, 'bot.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const b = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
  assert.equal(b.source, 'file');
  assert.equal(b.name, a.name);
  assert.equal(b.password, a.password);
  const e = botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'harbor-maple', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' }));
  assert.equal(e.source, 'env');
  assert.throws(() => botCredentials(loadConfig({ GIFOS_MCP_HOME: home, GIFOS_BOT_NAME: 'bot', GIFOS_BOT_PASSWORD: 'bot' })), /less obvious/);
});

test('rooms and links', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const r = newRoom(); assert.match(r, /^[0-9a-z]{24}$/); seen.add(r); }
  assert.equal(seen.size, 200);
  assert.equal(linkFor('https://gifos.app', 'abc'), 'https://gifos.app/run.html#v=abc');
  assert.equal(roomFromLink('https://gifos.app/run.html#v=abc-1&relay=x'), 'abc-1');
  assert.equal(roomFromLink('https://gifos.app/meet/Room42'), 'Room42');
  assert.equal(roomFromLink('https://gifos.app/meet/Room42/'), 'Room42');
  assert.equal(roomFromLink('https://gifos.app/index.html'), '');
  assert.equal(roomFromLink('javascript:alert(1)#v=abc'), '');
  assert.equal(roomFromLink('https://gifos.app/run.html#v=bad%20room'), '');
});

test('a restart puts live meetings back to scheduled', () => {
  const home = tmp();
  const s = new MeetingStore(home);
  const m = s.add({ topic: 'Demo meeting', room: 'r1', link: 'https://gifos.app/run.html#v=r1' });
  s.update(m.meeting_id, { state: 'live', session_id: 'mt_1', transcribing: true });
  const again = new MeetingStore(home);
  assert.equal(again.resetLive(), 1);
  assert.equal(new MeetingStore(home).get(m.meeting_id).state, 'scheduled');
  assert.equal(new MeetingStore(home).get(m.meeting_id).session_id, null);
});
