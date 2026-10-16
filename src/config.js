// Settings come from environment variables only, so a Grok Bot MCP config
// (command + args + env) is the whole setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_GIFOS_URL = 'https://gifos.app';
export const DEFAULT_STT_APP = 'offline-stt-whisper';

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
    vadEndMs: Number(env.GIFOS_VAD_END_MS) > 0 ? Number(env.GIFOS_VAD_END_MS) : 450,
    turnPauseMs: Number(env.GIFOS_TURN_PAUSE_MS) >= 0 && env.GIFOS_TURN_PAUSE_MS !== undefined && env.GIFOS_TURN_PAUSE_MS !== ''
      ? Number(env.GIFOS_TURN_PAUSE_MS) : 700,
  };
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
