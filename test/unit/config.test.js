import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, botCredentials, credentialProblem, generateCredentials, DEFAULT_GIFOS_URL, voiceConfig, SUGGESTED_LLM_URL, SUGGESTED_LLM_MODEL } from '../../src/config.js';
import { voicePublic, voiceSettings } from '../../src/voice/settings.js';
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

test('meeting voice is a Meet Bot setting, and the public view hides the endpoint', () => {
  const off = voiceConfig({ GIFOS_MCP_HOME: '/x' });
  assert.equal(off.conversationVoice, 'none');
  assert.equal(off.url, '');
  assert.equal(off.respondToCommand, true);
  const hidden = voicePublic(off, null);
  assert.equal(hidden.handed, false);
  assert.equal(hidden.conversation_voice, 'none');
  assert.equal(hidden.model, null);
  assert.equal(JSON.stringify(hidden).includes('api.x.ai'), false);
  const suggested = voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key' });
  assert.equal(suggested.conversationVoice, 'local');
  assert.equal(suggested.url, SUGGESTED_LLM_URL);
  assert.equal(suggested.model, SUGGESTED_LLM_MODEL);
  assert.equal(suggested.key, 'sk-test-key');
  assert.equal(voiceSettings(suggested).llm.provider, 'smartest');
  assert.equal('key' in voiceSettings(suggested).llm, false);
  assert.equal(JSON.stringify(voiceSettings(suggested)).includes('sk-test-key'), false);
  assert.equal(JSON.stringify(voiceSettings(suggested)).includes('api.x.ai'), false);
  const shown = voicePublic(suggested, { applied: true });
  assert.equal(shown.handed, true);
  assert.equal(shown.gap, null);
  assert.equal(shown.model, SUGGESTED_LLM_MODEL);
  assert.equal(JSON.stringify(shown).includes('sk-test-key'), false);
  assert.equal(JSON.stringify(shown).includes('api.x.ai'), false);
  const local = voiceConfig({ GIFOS_LLM_URL: 'http://127.0.0.1:9/v1/', GIFOS_LLM_MODEL: 'local-model' });
  assert.equal(local.conversationVoice, 'local');
  assert.equal(local.url, 'http://127.0.0.1:9/v1');
  assert.equal(local.model, 'local-model');
  assert.equal('ttsPath' in local, false);
  assert.equal('pauseMs' in local, false);
  assert.equal(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_VOICE: '0' }).conversationVoice, 'none');
  assert.equal('llm' in voiceSettings(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_VOICE: '0' })), false);
  assert.equal(voiceConfig({ GIFOS_CONVERSATION_VOICE: 'grok' }).conversationVoice, 'grok');
  assert.equal('llm' in voiceSettings(voiceConfig({ GIFOS_CONVERSATION_VOICE: 'grok' })), false);
  assert.equal(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_RESPOND_TO_COMMAND: '0' }).respondToCommand, false);
  assert.equal(local.tts.engine, 'kokoro');
  assert.equal(local.tts.source, 'mcp');
  assert.equal(local.tts.app, 'mcp-tts-kokoro');
  assert.equal(local.tts.voice, 'af_heart');
  assert.equal(local.sttUrl, '');
  const standin = voiceConfig({
    GIFOS_LLM_URL: 'http://127.0.0.1:9/v1',
    GIFOS_LLM_MODEL: 'local-model',
    GIFOS_TTS_URL: 'http://127.0.0.1:10/voice',
    GIFOS_STT_URL: 'http://127.0.0.1:11/captions',
    GIFOS_TTS_VOICE: 'af_heart',
  });
  assert.equal(standin.tts.engine, 'http');
  assert.equal(standin.tts.url, 'http://127.0.0.1:10/voice');
  const shownStandin = voicePublic(standin, { applied: true });
  assert.equal(shownStandin.tts.engine, 'http');
  assert.equal(shownStandin.stt, 'configured');
  assert.equal(JSON.stringify(shownStandin).includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(shownStandin).includes('sk-'), false);
  assert.equal(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_TTS_ENGINE: 'none' }).tts.engine, 'none');
  assert.equal(voiceSettings(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_TTS_ENGINE: 'none' })).tts.engine, 'none');
  assert.equal('tts' in voiceSettings(voiceConfig({ GIFOS_LLM_KEY: 'sk-test-key', GIFOS_TTS_ENGINE: 'none', GIFOS_VOICE: '0' })), false);
  assert.throws(() => voiceConfig({ GIFOS_TTS_ENGINE: 'piper' }), /GIFOS_TTS_ENGINE/);
  assert.throws(() => voiceConfig({ GIFOS_LLM_URL: 'not a url' }), /GIFOS_LLM_URL/);
  assert.throws(() => voiceConfig({ GIFOS_LLM_URL: 'http://127.0.0.1:9/v1' }), /GIFOS_LLM_MODEL/);
  assert.throws(() => voiceConfig({ GIFOS_CONVERSATION_VOICE: 'whisper' }), /GIFOS_CONVERSATION_VOICE/);
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

// A torn meetings.json (disk full, killed mid-write by another tool) must not
// be read as no meetings and then saved over: it holds every transcript.
test('an unreadable meetings.json is kept aside, not overwritten by the next save', () => {
  const home = tmp();
  try {
    const torn = '{"meetings":[{"meeting_id":"m_1","transcript":"the only copy of';
    fs.writeFileSync(path.join(home, 'meetings.json'), torn, { mode: 0o600 });
    const s = new MeetingStore(home);
    assert.equal(s.all().length, 0);
    s.add({ topic: 'After' });
    const kept = fs.readdirSync(home).filter((f) => f.startsWith('meetings.json.bad'));
    assert.equal(kept.length, 1, 'kept ' + JSON.stringify(fs.readdirSync(home)));
    assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), torn);
    assert.equal(fs.statSync(path.join(home, kept[0])).mode & 0o777, 0o600);
    assert.equal(new MeetingStore(home).all().length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A torn bot.json must not be replaced by a fresh pair: the old pair is the
// bot's identity and derives its admin meeting, and nothing else holds it.
test('an unreadable bot.json is kept aside, not overwritten by a fresh pair', () => {
  const home = tmp();
  try {
    const torn = '{"name":"notes-abc123","password":"only-copy-of-th';
    fs.writeFileSync(path.join(home, 'bot.json'), torn, { mode: 0o600 });
    const fresh = botCredentials(loadConfig({ GIFOS_MCP_HOME: home }));
    assert.equal(fresh.source, 'generated');
    const kept = fs.readdirSync(home).filter((f) => f.startsWith('bot.json.bad'));
    assert.equal(kept.length, 1, 'kept ' + JSON.stringify(fs.readdirSync(home)));
    assert.equal(fs.readFileSync(path.join(home, kept[0]), 'utf8'), torn);
    assert.equal(fs.statSync(path.join(home, kept[0])).mode & 0o777, 0o600);
    assert.equal(botCredentials(loadConfig({ GIFOS_MCP_HOME: home })).password, fresh.password);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A meetings.json save cut short must leave the last good file and no temp.
test('a meetings save cut short keeps the last good meetings.json', () => {
  const home = tmp();
  try {
    const s = new MeetingStore(home);
    const m = s.add({ topic: 'First' });
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, text, opts) => {
      if (String(file).includes('meetings.json')) {
        write(file, String(text).slice(0, 20), opts);
        const e = new Error('ENOSPC: no space left on device');
        e.code = 'ENOSPC';
        throw e;
      }
      return write(file, text, opts);
    };
    try {
      assert.throws(() => s.add({ topic: 'Second' }), /ENOSPC/);
    } finally {
      fs.writeFileSync = write;
    }
    assert.deepEqual(new MeetingStore(home).all().map((x) => x.meeting_id), [m.meeting_id]);
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
