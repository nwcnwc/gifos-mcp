// Speech-to-text heard the wake word "bot" as "Bart". Close variants count
// as the wake word, and a direct question is still a question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hearsWake, isDirectQuestion } from '../../src/voice/wake.js';
import { bridgeScript } from '../../src/voice/providers.js';

test('Bart is a wake word, and a direct question does not need the name', () => {
  assert.equal(hearsWake('hey bot', 'Harbor'), true);
  assert.equal(hearsWake('hey Bart, what time is it', 'Harbor'), true);
  assert.equal(hearsWake('Bart what did we decide', 'Harbor'), true);
  assert.equal(hearsWake('hello Harbor', 'Harbor'), true);
  assert.equal(hearsWake('I bought milk yesterday', 'Harbor'), false);
  assert.equal(hearsWake('sounds good', 'Harbor'), false);
  assert.equal(isDirectQuestion('what time is it'), true);
  assert.equal(isDirectQuestion('Can you take the notes?'), true);
  assert.equal(isDirectQuestion('We should ship the notes today.'), false);
});

test('the launch script teaches Meet Bot the same wake rule', () => {
  function bare() {
    return {
      isCommand(text) {
        const t = String(text || '').trim().toLowerCase();
        return /^(hey |ok |hi |hello )?bot\b/.test(t);
      },
      isConversation(text) {
        const t = String(text || '').trim();
        if (!t || this.isCommand(t)) return false;
        if (/\?\s*$/.test(t)) return true;
        return t.length >= 24;
      },
    };
  }
  const sandbox = {
    BotVoice: bare(),
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { href: 'https://gifos.app/run.html' },
    setTimeout(fn) { fn(); },
    GifOS: { providers: { call() { return Promise.reject(new Error('store')); }, assigned() { return null; } } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bridgeScript({ hostRoles: ['tts', 'smartest'] }), sandbox);
  const voice = sandbox.BotVoice;
  assert.equal(voice.isCommand('hey bot', 'Harbor'), true);
  assert.equal(voice.isCommand('hey Bart', 'Harbor'), true);
  assert.equal(voice.isCommand('Bart what did we decide', 'Harbor'), true);
  assert.equal(voice.isCommand('I bought milk yesterday', 'Harbor'), false);
  assert.equal(voice.isConversation('what time is it', 'Harbor'), true);
  assert.equal(voice.isConversation('sounds good', 'Harbor'), false);
  assert.equal(voice.isConversation('hey Bart', 'Harbor'), false);

  sandbox.BotVoice = bare();
  assert.equal(sandbox.BotVoice.isCommand('hello bought', 'Harbor'), true);
  assert.equal(sandbox.BotVoice.isConversation('where did we leave it', 'Harbor'), true);
});
