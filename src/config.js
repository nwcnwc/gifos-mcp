// Settings come from environment variables only, so a Grok Bot MCP config
// (command + args + env) is the whole setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { KOKORO_VOICE, MCP_TTS_APP } from './voice/settings.js';

export const DEFAULT_GIFOS_URL = 'https://gifos.app';
export const DEFAULT_STT_APP = 'offline-stt-whisper';

// Suggested local-LLM setting for Meet Bot: xAI Grok over its public
// OpenAI-compatible API. grok-4.20-0309-non-reasoning answers without a
// reasoning pass. When this process hosts smartest, it calls that endpoint.
// The page does not. GIFOS_LLM_MODEL
// overrides the model name.
export const SUGGESTED_LLM_URL = 'https://api.x.ai/v1';
export const SUGGESTED_LLM_MODEL = 'grok-4.20-0309-non-reasoning';

function cleanBase(u, name) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\/[^/\s]+/.test(s)) throw new Error(name + ' must be an http(s) URL, got: ' + JSON.stringify(u));
  return s;
}

function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return ''; }
}

function cleanUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(s)) throw new Error('GIFOS_URL must be an http(s) URL, got: ' + JSON.stringify(u));
  return s;
}

export function loadConfig(env = process.env) {
  const home = env.GIFOS_MCP_HOME || path.join(os.homedir(), '.gifos-mcp');
  const stt = env.GIFOS_STT_APP === undefined ? DEFAULT_STT_APP : String(env.GIFOS_STT_APP).trim();
  return {
    home,
    gifosUrl: cleanUrl(env.GIFOS_URL || DEFAULT_GIFOS_URL),
    relay: String(env.GIFOS_RELAY || '').trim(),
    botName: String(env.GIFOS_BOT_NAME || '').trim(),
    botPassword: String(env.GIFOS_BOT_PASSWORD || ''),
    sttApp: stt === 'none' ? '' : stt,
    headless: env.GIFOS_HEADLESS !== '0',
    chrome: String(env.GIFOS_CHROME || '').trim(),
    botAudio: env.GIFOS_BOT_AUDIO ? path.resolve(String(env.GIFOS_BOT_AUDIO).trim()) : '', // Chromium needs an absolute path
    shotsDir: String(env.GIFOS_MCP_SHOTS || '').trim(),
    timeoutMs: Number(env.GIFOS_TIMEOUT_MS) > 0 ? Number(env.GIFOS_TIMEOUT_MS) : 120000,
    autoInstallBrowser: env.GIFOS_MCP_NO_INSTALL !== '1',
    prewarm: env.GIFOS_MCP_LAZY !== '1',
    debug: env.GIFOS_MCP_DEBUG === '1',
    maxMeetings: positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS'),
    capacityNear: nearCount(env),
    horizonMs: positiveInt(env.GIFOS_SCHEDULE_HORIZON_MS, 24 * 60 * 60 * 1000, 'GIFOS_SCHEDULE_HORIZON_MS'),
    // Stage B: more than one worker runs each Meet Bot in its own child
    // process and Chromium. Rooms per worker defaults to an even share of the cap.
    workers: positiveInt(env.GIFOS_WORKERS, 1, 'GIFOS_WORKERS'),
    workerRooms: workerRooms(env),
    voice: voiceConfig(env),
  };
}

// Provisional until a machine is measured. Stage A needs an explicit cap.
function positiveInt(raw, fallback, name) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(name + ' must be a positive integer.');
  return n;
}

function nearCount(env) {
  const cap = positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS');
  if (env.GIFOS_CAPACITY_NEAR == null || String(env.GIFOS_CAPACITY_NEAR).trim() === '') return Math.max(1, cap - 1);
  const near = positiveInt(env.GIFOS_CAPACITY_NEAR, 1, 'GIFOS_CAPACITY_NEAR');
  if (near > cap) throw new Error('GIFOS_CAPACITY_NEAR cannot be above GIFOS_MAX_MEETINGS.');
  return near;
}

function workerRooms(env) {
  const cap = positiveInt(env.GIFOS_MAX_MEETINGS, 4, 'GIFOS_MAX_MEETINGS');
  const workers = positiveInt(env.GIFOS_WORKERS, 1, 'GIFOS_WORKERS');
  const rooms = positiveInt(env.GIFOS_WORKER_ROOMS, Math.ceil(cap / workers), 'GIFOS_WORKER_ROOMS');
  if (rooms * workers < cap) throw new Error('GIFOS_WORKERS x GIFOS_WORKER_ROOMS must cover GIFOS_MAX_MEETINGS.');
  return rooms;
}

const VOICES = new Set(['none', 'grok', 'local']);

// Settings Meet Bot will own. A key with no URL uses the suggested xAI
// endpoint. This process calls that endpoint only when it hosts smartest.
export function voiceConfig(env = process.env) {
  const key = String(env.GIFOS_LLM_KEY || '');
  const llmApp = String(env.GIFOS_LLM_APP || '').trim();
  const url = env.GIFOS_LLM_URL === undefined || String(env.GIFOS_LLM_URL).trim() === ''
    ? (key && !llmApp ? SUGGESTED_LLM_URL : '')
    : cleanBase(env.GIFOS_LLM_URL, 'GIFOS_LLM_URL');
  const xai = hostOf(url) === 'api.x.ai';
  const model = String(env.GIFOS_LLM_MODEL || (xai ? SUGGESTED_LLM_MODEL : '')).trim();
  let conversationVoice = String(env.GIFOS_CONVERSATION_VOICE || '').trim().toLowerCase();
  if (env.GIFOS_VOICE === '0') conversationVoice = 'none';
  else if (!conversationVoice) conversationVoice = (key || url || llmApp) ? 'local' : 'none';
  if (!VOICES.has(conversationVoice)) throw new Error('GIFOS_CONVERSATION_VOICE must be none, grok, or local.');
  if (conversationVoice === 'local' && !llmApp) {
    if (!url) throw new Error('GIFOS_LLM_URL or GIFOS_LLM_KEY is required when conversation voice is local.');
    if (!model) throw new Error('GIFOS_LLM_MODEL is required for this GIFOS_LLM_URL.');
  }
  const sttRaw = env.GIFOS_STT_APP === undefined ? DEFAULT_STT_APP : String(env.GIFOS_STT_APP).trim();
  const pollRaw = Number(env.GIFOS_TRANSCRIPT_POLL_MS);
  return {
    conversationVoice,
    respondToCommand: env.GIFOS_RESPOND_TO_COMMAND !== '0',
    url,
    key,
    model,
    llmApp,
    pollMs: pollRaw > 0 ? pollRaw : 500,
    tts: ttsConfig(env),
    sttUrl: sttUrl(env),
    sttApp: sttRaw === 'none' ? '' : sttRaw,
  };
}

// Speech for Meet Bot's local mode. Default Kokoro runs in this process
// (source "mcp"). The headless harness injects this process as the tts
// provider. GIFOS_TTS_APP names a store provider instead. GIFOS_TTS_URL is
// fetched by this process, not by the page.
const TTS_ENGINES = new Set(['', 'auto', 'kokoro', 'none']);

function ttsConfig(env) {
  const ask = String(env.GIFOS_TTS_ENGINE || '').trim().toLowerCase();
  if (!TTS_ENGINES.has(ask)) {
    throw new Error('GIFOS_TTS_ENGINE must be auto, kokoro, or none.');
  }
  const named = String(env.GIFOS_TTS_VOICE || '').trim();
  if (ask === 'none') return { engine: 'none' };
  const url = String(env.GIFOS_TTS_URL || '').trim();
  if (url) return { engine: 'http', url: cleanBase(url, 'GIFOS_TTS_URL'), voice: named };
  const app = String(env.GIFOS_TTS_APP || '').trim();
  if (app) return { engine: 'kokoro', app, voice: named || KOKORO_VOICE, source: 'store' };
  return { engine: 'kokoro', app: MCP_TTS_APP, voice: named || KOKORO_VOICE, source: 'mcp' };
}

function sttUrl(env) {
  const url = String(env.GIFOS_STT_URL || '').trim();
  return url ? cleanBase(url, 'GIFOS_STT_URL') : '';
}

// Mirrors the Meeting Bot's own strength rule (protocol.js), so a pair we
// generate or accept is never refused by the app.
const WEAK = ['bot', 'password', 'password1', '12345678', '123456789', 'admin', 'letmein', 'qwerty', 'gifos', 'secret', 'changeme'];
export function credentialProblem(name, password) {
  name = String(name || '').trim();
  password = String(password || '');
  const nl = name.toLowerCase();
  const pl = password.toLowerCase();
  if (nl.length < 3) return 'Bot name needs at least 3 characters.';
  if (name.length > 40) return 'Bot name is at most 40 characters.';
  if (WEAK.includes(nl)) return 'Pick a less obvious bot name.';
  if (password.length < 10) return 'Bot password needs at least 10 characters.';
  if (pl === nl) return 'Bot password must not be the name.';
  if (WEAK.includes(pl)) return 'That bot password is too easy to guess.';
  if (!(/[a-z]/i.test(password) && /[0-9]/.test(password)) && password.length < 14) return 'Use a letter and a digit in the bot password, or a longer one.';
  return '';
}

export function generateCredentials() {
  const name = 'notes-' + crypto.randomBytes(3).toString('hex');
  // 24 base64url chars plus a fixed digit: always a letter and a digit.
  const password = crypto.randomBytes(18).toString('base64url') + '7';
  return { name, password };
}

// The bot credential is the only secret. It stays in GIFOS_MCP_HOME/bot.json
// (mode 0600) unless the user passes GIFOS_BOT_NAME / GIFOS_BOT_PASSWORD.
export function botCredentials(cfg) {
  if (cfg.botName || cfg.botPassword) {
    const p = credentialProblem(cfg.botName, cfg.botPassword);
    if (p) throw new Error('GIFOS_BOT_NAME / GIFOS_BOT_PASSWORD: ' + p);
    return { name: cfg.botName, password: cfg.botPassword, source: 'env' };
  }
  const file = path.join(cfg.home, 'bot.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!credentialProblem(saved.name, saved.password)) return { name: saved.name, password: saved.password, source: 'file' };
  } catch (e) { /* first run */ }
  const fresh = generateCredentials();
  fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { ...fresh, source: 'generated' };
}
