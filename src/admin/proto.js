// Meeting Bot admin-room protocol (gb1). The name and password derive the
// secret room the same way the store app does. This file never logs either.
import crypto from 'node:crypto';

const ITER = 20000;
const SALT_PREFIX = 'gifos-meet-bot-v1|';

export function deriveAdmin(name, password) {
  const salt = SALT_PREFIX + String(name || '').trim();
  const bits = crypto.pbkdf2Sync(String(password || ''), salt, ITER, 32, 'sha256');
  const hex = bits.toString('hex');
  return { room: hex.slice(0, 32), password: hex.slice(32, 64) };
}

export function encode(msg) {
  const body = Object.assign({ v: 1 }, msg || {});
  return 'gb1 ' + JSON.stringify(body);
}

export function decode(text) {
  if (typeof text !== 'string' || !text.startsWith('gb1 ')) return null;
  let o;
  try { o = JSON.parse(text.slice(4)); } catch (e) { return null; }
  if (!o || o.v !== 1) return null;
  if (o.role !== 'bot' && o.role !== 'controller') return null;
  if (typeof o.op !== 'string' || !o.op) return null;
  return o;
}

// Commands this controller sends. provider-call is the bot asking us.
export const COMMANDS = [
  'list', 'status', 'create', 'join', 'leave', 'end', 'record', 'transcribe',
  'say', 'speak', 'people', 'transcript', 'recording', 'providers', 'switches',
];
