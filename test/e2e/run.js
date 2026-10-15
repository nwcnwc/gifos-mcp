// End-to-end: a real GifOS, a real MCP client over stdio, a real meeting.
//
//   GIFOS_APP_DIR=../gifos-app MEETING_BOT_SRC=../gifos-apps-source/meeting-bot \
//   E2E_SPEECH_WAV=/path/to/speech.wav npm run test:e2e
//
// 1. Serves GIFOS_APP_DIR on 127.0.0.1:19510 with Meeting Bot added to its store.
// 2. Starts a relay (RELAY_SCRIPT, on 19511) or uses E2E_RELAY.
// 3. Spawns bin/gifos-mcp.js over stdio and drives it with an MCP client:
//    create_meeting -> start_meeting -> a second headless browser joins as
//    "Alice" and plays speech -> get_transcript is non-empty -> share_content,
//    mute/unmute, list_meetings, status -> end_meeting -> the bot is gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packApp, startSite } from './site.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SITE_DIR = process.env.GIFOS_APP_DIR ? path.resolve(process.env.GIFOS_APP_DIR) : '';
const BOT_SRC = process.env.MEETING_BOT_SRC ? path.resolve(process.env.MEETING_BOT_SRC) : '';
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 19510);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 19511);
const STT = process.env.E2E_STT || 'whisper';            // whisper | synthetic
const SPEECH = process.env.E2E_SPEECH_WAV || '';
const EXPECT = new RegExp(process.env.E2E_EXPECT || (STT === 'synthetic' ? 'synthetic speech' : '[A-Za-z]{3,}'), 'i');
const PROOF = path.resolve(process.env.E2E_PROOF_DIR || path.join(REPO, '.e2e', 'proof'));
const BASE = 'http://127.0.0.1:' + SITE_PORT;
const TRANSCRIPT_WAIT_MS = Number(process.env.E2E_TRANSCRIPT_WAIT_MS || 300000);
const CALL = { timeout: 600000 }; // the first call may install apps and start two browsers

let failures = 0;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (s) => console.log(stamp() + ' ' + s);
const check = (name, cond, detail) => {
  say((cond ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  (' + String(detail).slice(0, 300) + ')' : ''));
  if (!cond) failures++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

function need(cond, msg) { if (!cond) { console.error('e2e setup: ' + msg); process.exit(2); } }

// Synthetic speech-to-text provider: "synthetic speech" for any loud clip.
const SYNTH_STT = {
  'manifest.json': JSON.stringify({ gifos: '1.0', appId: 'stt-synthetic', name: 'Synthetic Speech', version: '1.0', entry: 'index.html', capabilities: {}, provides: { ai: ['stt'] } }),
  'index.html': '<!doctype html><meta charset="utf-8"><title>Synthetic Speech</title><script>gifos.provider.serve({ stt: function (req) {' +
    'var raw = req && req.bytes; var u = !raw ? new Float32Array(0) : (raw instanceof Float32Array ? raw : new Float32Array(raw.buffer || raw));' +
    'var acc = 0, n = 0; for (var i = 0; i < u.length; i += 16) { acc += u[i] * u[i]; n++; }' +
    'return { text: (n ? Math.sqrt(acc / n) : 0) > 0.02 ? "synthetic speech" : "" }; } });<\/script>',
};

function noiseWav(dest) {
  const rate = 44100, loud = rate * 2, quiet = Math.floor(rate * 1.2);
  const data = Buffer.alloc((loud + quiet) * 2);
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0x100000000) * 2 - 1; };
  for (let i = 0; i < loud; i++) data.writeInt16LE((Math.max(-1, Math.min(1, 0.55 * Math.sin(2 * Math.PI * 440 * i / rate) + 0.4 * rnd())) * 32767) | 0, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(dest, Buffer.concat([h, data]));
}

async function waitPort(port, ms) {
  const net = await import('node:net');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  need(SITE_DIR && fs.existsSync(path.join(SITE_DIR, 'run.html')), 'set GIFOS_APP_DIR to a gifos-app checkout (release/0.9.23 or later)');
  need(BOT_SRC && fs.existsSync(path.join(BOT_SRC, 'manifest.json')), 'set MEETING_BOT_SRC to the meeting-bot source folder (gifos-apps-source)');
  need(STT === 'whisper' || STT === 'synthetic', 'E2E_STT is whisper or synthetic');
  need(STT !== 'whisper' || (SPEECH && fs.existsSync(SPEECH)), 'whisper mode needs E2E_SPEECH_WAV, a WAV file of someone speaking');
  fs.mkdirSync(PROOF, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-e2e-'));
  const wav = SPEECH || path.join(work, 'noise.wav');
  if (!SPEECH) noiseWav(wav);
  say('site ' + BASE + ' from the gifos-app checkout; STT ' + STT + '; speech ' + path.basename(wav));

  // ---- local GifOS with Meeting Bot in its store ----
  const logo = fs.readFileSync(path.join(REPO, 'assets', 'logo-512.png'));
  const bot = await packApp(BOT_SRC, SITE_DIR, ['manifest.json', 'index.html', 'app.js', 'protocol.js', 'help.md', 'listing.json']);
  const extra = [{ slug: 'meeting-bot', ...bot, cover: logo }];
  if (STT === 'synthetic') {
    const dir = path.join(work, 'stt-synthetic');
    fs.mkdirSync(dir);
    for (const [n, t] of Object.entries(SYNTH_STT)) fs.writeFileSync(path.join(dir, n), t);
    extra.push({ slug: 'stt-synthetic', ...(await packApp(dir, SITE_DIR, ['manifest.json', 'index.html'])), cover: logo });
  }
  const site = await startSite({ siteDir: SITE_DIR, port: SITE_PORT, extraApps: extra });
  check('local GifOS store lists meeting-bot', true, 'meeting-bot ' + bot.manifest.version + ', ' + bot.bytes.length + ' bytes');

  let relayProc = null;
  let relay = process.env.E2E_RELAY || '';
  if (process.env.RELAY_SCRIPT) {
    relay = 'ws://127.0.0.1:' + RELAY_PORT;
    relayProc = spawn(process.execPath, [process.env.RELAY_SCRIPT], { env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ['ignore', 'ignore', 'pipe'] });
    relayProc.stderr.on('data', (d) => process.stdout.write('  [relay] ' + d));
    need(await waitPort(RELAY_PORT, 15000), 'the relay did not start on ' + RELAY_PORT);
  }
  say('relay ' + (relay || '(GifOS default)'));

  // ---- the MCP server, over stdio ----
  const mcpHome = path.join(work, 'mcp-home');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'bin', 'gifos-mcp.js')],
    env: {
      ...process.env,
      GIFOS_URL: BASE,
      GIFOS_RELAY: relay,
      GIFOS_MCP_HOME: mcpHome,
      GIFOS_STT_APP: STT === 'synthetic' ? 'stt-synthetic' : 'offline-stt-whisper',
      GIFOS_MCP_SHOTS: PROOF,
    },
    stderr: 'pipe',
  });
  transport.stderr.on('data', (d) => process.stdout.write('  ' + String(d).replace(/\n(?=.)/g, '\n  ')));
  const client = new Client({ name: 'gifos-mcp-e2e', version: '1' });
  let human = null;
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    check('MCP server lists its tools over stdio', tools.length === 10, tools.map((t) => t.name).join(', '));

    const created = await client.callTool({ name: 'create_meeting', arguments: { topic: 'Demo meeting', start_time: '17:00' } }, undefined, CALL);
    const meeting = JSON.parse(text(created));
    check('create_meeting returns a meeting_id and a link on the local GifOS', /^m_/.test(meeting.meeting_id) && meeting.link.startsWith(BASE + '/run.html#v='), meeting.link);

    const started = await client.callTool({ name: 'start_meeting', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
    const live = started.isError ? null : JSON.parse(text(started));
    if (!check('start_meeting: the bot installs from the store, joins and transcribes', live && live.state === 'live' && live.transcribing, text(started))) throw new Error('start failed');

    const st = JSON.parse(text(await client.callTool({ name: 'status', arguments: {} }, undefined, CALL)));
    check('status: bot ready, one live meeting, STT app installed', st.bot.state === 'ready' && st.live_meetings.length === 1 && st.bot.stt_ready, JSON.stringify(st));

    // ---- a person joins and talks ----
    human = await chromium.launch({
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav,
        '--autoplay-policy=no-user-gesture-required'],
    });
    const hctx = await human.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
    await hctx.addInitScript({ content: 'try{localStorage.setItem("gifos_name","Alice");localStorage.setItem("gifos_meet_bar","0");' +
      (relay ? 'localStorage.setItem("gifos_relay",' + JSON.stringify(relay) + ');' : '') + '}catch(e){}' });
    const alice = await hctx.newPage();
    alice.on('pageerror', (e) => say('  [alice] ' + e.message));
    await alice.goto(meeting.link + '&DEBUG=on', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await alice.locator('.tile .botbadge').first().waitFor({ timeout: 90000 });
    let tile = '';
    for (let i = 0; i < 40; i++) {
      tile = await alice.locator('.tile', { has: alice.locator('.botbadge') }).first().innerText();
      if (/transcribing/.test(tile)) break;
      await sleep(500);
    }
    // GifOS joins with the mic off; Alice turns hers on to talk.
    await alice.locator('#mic').click();
    const micOn = await alice.waitForSelector('#mic:not(.off)', { timeout: 15000 }).then(() => true, () => false);
    check('Alice turns her microphone on', micOn);
    check('Alice sees the 🤖 bot badge', /bot/.test(tile), tile.replace(/\s+/g, ' '));
    check('Alice sees the transcribing chip', /transcribing/.test(tile), tile.replace(/\s+/g, ' '));
    await alice.screenshot({ path: path.join(PROOF, 'alice-sees-bot.png') });

    let transcript = '';
    const end = Date.now() + TRANSCRIPT_WAIT_MS;
    while (Date.now() < end) {
      const r = await client.callTool({ name: 'get_transcript', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
      transcript = r.isError ? '' : text(r);
      if (/^Alice: /m.test(transcript) && EXPECT.test(transcript)) break;
      await sleep(5000);
    }
    say('transcript so far:\n' + transcript.split('\n').slice(0, 12).map((l) => '    | ' + l).join('\n'));
    check('get_transcript returns Alice\'s words', /^Alice: /m.test(transcript) && EXPECT.test(transcript), 'expect ' + EXPECT);

    const shared = await client.callTool({ name: 'share_content', arguments: { meeting_id: meeting.meeting_id, text: 'Agenda for the demo meeting: intro, questions.' } }, undefined, CALL);
    check('share_content answers', !shared.isError, text(shared));
    await alice.locator('#chatbtn').click();
    await alice.locator('#chatlog', { hasText: 'Agenda for the demo meeting' }).waitFor({ timeout: 30000 }).then(() => true, () => false)
      .then((seen) => check('Alice sees the shared text in chat', seen));
    await alice.screenshot({ path: path.join(PROOF, 'alice-chat.png') });

    const muted = JSON.parse(text(await client.callTool({ name: 'mute', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    let chipGone = false;
    for (let i = 0; i < 40 && !chipGone; i++) {
      chipGone = !/transcribing/.test(await alice.locator('.tile', { has: alice.locator('.botbadge') }).first().innerText());
      if (!chipGone) await sleep(500);
    }
    check('mute stops transcribing and Alice sees the chip go', muted.muted === true && muted.transcribing === false && chipGone);
    const unmuted = JSON.parse(text(await client.callTool({ name: 'unmute', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    check('unmute turns transcribing back on', unmuted.transcribing === true);

    const listed = JSON.parse(text(await client.callTool({ name: 'list_meetings', arguments: {} }, undefined, CALL)));
    check('list_meetings shows the live meeting', listed.meetings.length === 1 && listed.meetings[0].state === 'live');

    const ended = JSON.parse(text(await client.callTool({ name: 'end_meeting', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL)));
    check('end_meeting: the bot leaves and keeps the transcript', ended.state === 'ended' && ended.transcript_lines >= 1, JSON.stringify(ended));
    const gone = await alice.waitForFunction(() => !document.querySelector('.tile .botbadge'), null, { timeout: 45000 }).then(() => true, () => false);
    check('Alice no longer sees the bot', gone);
    await alice.screenshot({ path: path.join(PROOF, 'alice-after-end.png') });

    const after = await client.callTool({ name: 'get_transcript', arguments: { meeting_id: meeting.meeting_id } }, undefined, CALL);
    check('get_transcript still works after end_meeting', !after.isError && /^Alice: /m.test(text(after)), text(after).slice(0, 200));
  } catch (e) {
    check('suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    if (human) await human.close().catch(() => {});
    await client.close().catch(() => {});
    if (relayProc) relayProc.kill();
    site.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  say(failures ? failures + ' FAILURE(S)' : 'ALL PASS');
  say('screenshots in ' + PROOF);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
