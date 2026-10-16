// Command replies and conversation voice. No network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechTurn } from '../../src/providers/speech.js';
import { Converse, isCommand, readyClauses } from '../../src/providers/converse.js';
import { mouthInitScript } from '../../src/providers/mouth.js';

test('a command is a slash, a bang, or the bot name first', () => {
  assert.equal(isCommand('/leave now', []), true);
  assert.equal(isCommand('!note that', []), true);
  assert.equal(isCommand('Bot, what time is it?', []), true);
  assert.equal(isCommand('harbor-north please summarize', ['harbor-north']), true);
  assert.equal(isCommand('I think we should ship it', ['harbor-north']), false);
  assert.equal(isCommand('  ', []), false);
});

test('the first short clause is ready before the rest of the sentence', () => {
  const early = readyClauses('Hello friend today, we should talk about', 0, false);
  assert.ok(early.next.length >= 1, early.next.join(' | '));
  assert.ok(early.next[0].split(/\s+/).length <= 6, early.next[0]);
  const later = readyClauses('Hello friend today, we should talk about the weather.', early.emitted, true);
  assert.ok(later.next.length >= 1);
  assert.notEqual(later.next[0], early.next[0]);
});

function scripted(parts) {
  return async (_messages, onDelta) => {
    let all = '';
    for (const p of parts) {
      all += p;
      await onDelta(p);
    }
    return all;
  };
}

test('conversation waits, then speaks the short clause first, and a command cuts it off', async () => {
  const turn = new SpeechTurn();
  turn.set({ respond_to_command: true, conversation_voice: 'local' });
  const spoken = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const converse = new Converse({
    turn,
    pauseMs: 0,
    complete: scripted(['Hello friend today, we should talk about the weather. Then we leave.']),
    speakText: async (clause, ctx) => {
      spoken.push({ clause, engine: ctx.engine, kind: ctx.kind });
      if (spoken.length === 1) await gate;
    },
  });
  const pending = converse.onHeard({ speaker: 'Ada', text: 'What should we do next?', names: ['Helper'] });
  for (let i = 0; i < 50 && spoken.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(spoken.length, 1);
  assert.ok(spoken[0].clause.split(/\s+/).length <= 6, spoken[0].clause);
  const cmd = converse.onHeard({ speaker: 'Ada', text: '/stop the recording', names: ['Helper'] });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [conv, command] = await Promise.all([pending, cmd]);
  assert.equal(conv.spoke, false);
  assert.equal(command.kind, 'command');
  assert.equal(command.yielded, true);
  assert.ok(command.spoken.length >= 1);
  assert.equal(spoken.filter((s) => s.kind === 'conversation').length, 1);
});

test('commands stay quiet when the switch is off, and conversation stays quiet on none', async () => {
  const turn = new SpeechTurn();
  turn.set({ respond_to_command: false, conversation_voice: 'none' });
  const spoken = [];
  const converse = new Converse({
    turn,
    pauseMs: 0,
    complete: scripted(['Hello there.']),
    speakText: async (clause) => { spoken.push(clause); },
  });
  const cmd = await converse.onHeard({ speaker: 'Ada', text: 'bot leave', names: [] });
  assert.equal(cmd.spoke, false);
  assert.equal(cmd.reason, 'commands-off');
  const chat = await converse.onHeard({ speaker: 'Ada', text: 'How is the draft?', names: [] });
  assert.equal(chat.spoke, false);
  assert.equal(chat.reason, 'voice-off');
  assert.equal(spoken.length, 0);
  const say = turn.beginCommand();
  assert.equal(say.speak, true);
  turn.endCommand();
});

test('an empty model reply still speaks a short command acknowledgement', async () => {
  const turn = new SpeechTurn();
  turn.set({ respond_to_command: true, conversation_voice: 'none' });
  const spoken = [];
  const converse = new Converse({
    turn,
    pauseMs: 0,
    complete: async () => '',
    speakText: async (clause) => { spoken.push(clause); },
  });
  const cmd = await converse.onHeard({ speaker: 'Ada', text: '!note the date', names: [] });
  assert.equal(cmd.spoke, true);
  assert.deepEqual(spoken, ['I heard you.']);
});

test('the meeting mouth script keeps the key off the page and holds the track while speaking', () => {
  const src = mouthInitScript();
  assert.match(src, /__gifosMb/);
  assert.match(src, /__gifosHoldVoice/);
  assert.match(src, /__gifosPlayEncoded/);
  assert.match(src, /__gifosQuiet/);
  assert.equal(src.includes('GIFOS_LLM_KEY'), false);
  assert.equal(src.includes('authorization'), false);
  assert.equal(src.includes('Bearer'), false);
});
