#!/usr/bin/env node
// Three scripted checks against a live GifOS, in one open room:
//   1. a person plays a known wav; the participant attributes those words to them
//   2. the participant speaks a known line; the person hears those words
//   3. the person talks over a long line; say() returns interrupted
//
//   GIFOS_URL=https://... GIFOS_RELAY=wss://... GIFOS_MCP_HOME=... npm run test:participant
//
// Nothing in the proof file keeps the host name. Set the three variables above.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { MeetingStore, linkFor, newRoom } from '../../src/meetings.js';
import { ParticipantHost } from '../../src/participant/host.js';
import { ParticipantSession } from '../../src/participant/session.js';
import { concatI16, i16FromB64, wavFromPcm } from '../../src/audio/wav.js';
import { keywordHits } from '../../src/audio/wer.js';

try { os.setPriority(15); } catch (e) { /* nice(1) from the shell covers this */ }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'purple-giraffe.wav');
const PHRASE = 'the purple giraffe reads seven books';
const KEYS = ['purple', 'giraffe', 'seven', 'books'];
const LONG = ('Please hold while I describe the quiet library, the green river, and the seven red notebooks on the oak table. ').repeat(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) {
    process.stderr.write('test:participant needs ' + name + ' in the environment.\n');
    process.exit(2);
  }
  return v;
}

function redact(s) {
  let o = String(s);
  for (const key of ['GIFOS_URL', 'GIFOS_RELAY']) {
    const v = process.env[key];
    if (v) o = o.split(v).join('<' + key + '>');
  }
  return o.replace(/[a-z0-9-]+\.tail[0-9a-z]+\.ts\.net/gi, '<host>');
}

function hits(text) { return keywordHits(text, KEYS); }

async function waitFor(label, fn, ms) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(label + ' timed out. last=' + JSON.stringify(last));
}

const url = need('GIFOS_URL');
need('GIFOS_RELAY');
need('GIFOS_MCP_HOME');
if (!process.env.GIFOS_STT_THREADS) process.env.GIFOS_STT_THREADS = '2';

const cfg = loadConfig();
const meetings = new MeetingStore(path.join(cfg.home, 'participant-test-meetings'));
const stamp = process.pid + '-' + Date.now().toString(36);
const human = new ParticipantSession(cfg, { profile: 'profile-human-' + stamp });
const bot = new ParticipantHost(cfg, meetings, () => new ParticipantSession(cfg, { profile: 'profile-bot-' + stamp }));

const chunks = [];
let record = false;
human.onFrame = (frame) => {
  if (!record || !frame || !frame.b64) return;
  try { chunks.push(i16FromB64(frame.b64)); } catch (e) {}
};

const proof = [];
const note = (line) => { proof.push(line); process.stderr.write(line + '\n'); };
let failed = '';

try {
  if (!fs.existsSync(FIXTURE)) throw new Error('missing fixture ' + FIXTURE);
  const fixture = fs.readFileSync(FIXTURE);
  const fixtureB64 = fixture.toString('base64');
  const room = newRoom();
  let link = linkFor(url.replace(/\/+$/, ''), room, process.env.GIFOS_RELAY);
  if (!/DEBUG=on/i.test(link)) link += '&DEBUG=on';
  note('room opened (link redacted) ' + redact(link));

  const tJoin = Date.now();
  await Promise.all([
    bot.join({ url: link, display_name: 'Helper' }),
    human.join({ url: link, name: 'Ada', password: '', avatarDataUrl: '', vadEndMs: cfg.vadEndMs || 450 }),
  ]);
  note('both seated in ' + ((Date.now() - tJoin) / 1000).toFixed(1) + 's as "' + bot.displayName + '" and "Ada"');

  await waitFor('disclosure', async () => {
    const st = await bot.meetingState();
    return st.disclosed && !st.self_speaking ? st : null;
  }, 90000);
  note('disclosure spoken; mic/camera of the participant are up');

  // Human -> bot. The known wav is the whole microphone signal.
  const tHear = Date.now();
  const played = human.play(fixtureB64, false);
  const heard = [];
  let since = '';
  while (Date.now() - tHear < 60000) {
    const batch = await bot.utterances({ since, wait_ms: 4000 });
    for (const u of batch.utterances) {
      heard.push(u);
      since = u.id;
      note('heard ' + u.speaker + ': ' + u.text);
    }
    if (hits(heard.map((u) => u.text).join(' ')).length === KEYS.length) break;
    if (batch.utterances.length === 0 && heard.length && Date.now() - tHear > 15000) break;
  }
  await played.catch(() => {});
  const heardText = heard.map((u) => u.text).join(' ');
  const heardHits = hits(heardText);
  const speaker = (heard.find((u) => hits(u.text).length) || {}).speaker || '';
  note('human->bot in ' + ((Date.now() - tHear) / 1000).toFixed(1) + 's hits=' + heardHits.join(',') + ' speaker=' + JSON.stringify(speaker));
  if (heardHits.length !== KEYS.length) throw new Error('human->bot missed words: ' + JSON.stringify(heardText));
  if (!/Ada/.test(speaker)) throw new Error('human->bot attributed to ' + JSON.stringify(speaker) + ' not Ada');

  // Bot -> human. Record only this line, then transcribe it on the server.
  await human.page.evaluate(() => { if (window.__vbStats) { window.__vbStats.peak = 0; window.__vbStats.frames = 0; } });
  chunks.length = 0;
  record = true;
  const tSay = Date.now();
  const said = await bot.say(PHRASE, '', true);
  await sleep(900);
  record = false;
  const pcm = chunks.length ? concatI16(chunks) : new Int16Array(0);
  note('bot said ' + said.spoken_until_ms + 'ms ttfa_ms=' + (said.ttfa_ms == null ? 'n/a' : said.ttfa_ms) + ', human captured ' + pcm.length + ' samples');
  if (pcm.length < 8000) throw new Error('human captured too little audio (' + pcm.length + ' samples)');
  if (!bot.stt) throw new Error('the voice sidecar was not started');
  const back = await bot.stt.transcribe(wavFromPcm(pcm, 16000, 1));
  note('bot->human transcript: ' + back.text + ' (' + back.ms + 'ms)');
  const backHits = hits(back.text);
  if (backHits.length !== KEYS.length) throw new Error('bot->human missed words: ' + JSON.stringify(back.text));
  const echo = await bot.utterances({ since, wait_ms: 500 });
  const own = echo.utterances.filter((u) => /🤖/.test(u.speaker) || u.speaker === bot.displayName);
  if (own.length) throw new Error('bot transcribed itself: ' + JSON.stringify(own));
  note('bot->human in ' + ((Date.now() - tSay) / 1000).toFixed(1) + 's hits=' + backHits.join(',') + ' and the bot did not transcribe itself');

  // Barge-in. Reset the ear so the previous line does not count as "already loud".
  await human.page.evaluate(() => { if (window.__vbStats) { window.__vbStats.peak = 0; window.__vbStats.rms = 0; } });
  const tCut = Date.now();
  const sayP = bot.say(LONG, '', true);
  await waitFor('remote energy', async () => {
    const s = await human.stats();
    return s && (s.peak > 0.01 || s.rms > 0.008) ? s : null;
  }, 60000);
  await human.play(fixtureB64, false);
  const cut = await sayP;
  note('barge-in interrupted=' + cut.interrupted + ' spoken_until_ms=' + cut.spoken_until_ms + ' after ' + ((Date.now() - tCut) / 1000).toFixed(1) + 's');
  if (!cut.interrupted) throw new Error('say() was not interrupted. stats=' + JSON.stringify(await human.stats()));
  if (!(cut.spoken_until_ms > 80 && cut.spoken_until_ms < 20000)) throw new Error('spoken_until_ms out of range: ' + cut.spoken_until_ms);

  const state = await bot.meetingState();
  note('state participants=' + JSON.stringify(state.participants) + ' mic=' + state.mic_on + ' cam=' + state.camera_on + ' hand=' + state.hand_raised);
  if (bot.voice && bot.voice.health) {
    const h = await bot.voice.health();
    const sttName = h.engines && h.engines.stt;
    const ttsName = h.engines && h.engines.tts;
    const ttfa = h.self_test && h.self_test.ttfa_s;
    const rtf = h.self_test && h.self_test.tts_rtf;
    const vad = h.vad && h.vad.kind;
    note('sidecar stt=' + sttName + ' model=' + (h.engines && h.engines.stt_model) + ' tts=' + ttsName + ' vad=' + vad + ' self_test_ttfa_s=' + ttfa + ' self_test_tts_rtf=' + rtf);
  }
  const shot = await bot.snapshot();
  note('snapshot ' + (shot.snapshot || 'none'));
  const raw = bot.meetingId ? bot.readTranscript(bot.meetingId) : '';
  const rows = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
  for (const row of rows) note('transcript ' + row);
  note('PASS');
} catch (e) {
  failed = e && e.stack ? e.stack : String(e);
  note('FAIL ' + redact(failed));
} finally {
  await bot.close().catch(() => {});
  await human.close().catch(() => {});
  const dir = path.join(ROOT, 'test', 'proof');
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    '# Participant proof',
    '',
    'Scripted meeting. Host names are redacted. The known line is "' + PHRASE + '".',
    '',
    ...proof.map((l) => '- ' + l),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'participant.md'), body);
  if (failed) process.exit(1);
}
