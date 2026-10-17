// Private JSON files under GIFOS_MCP_HOME (schedule, meetings, bot credential).
// Shared so every store saves the same way and none saves over a file it
// could not read.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// Temp file then rename, so a save cut short (disk full, killed mid-write)
// leaves the last good file in place.
export function writePrivate(file, text) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// The parsed file, or null when it does not exist. A file that does not
// parse (or that `usable` refuses) is moved to <file>.bad-<ms> and null is
// returned: it may hold the only copy of what it stored, so the next save
// must not land on it.
export function readPrivate(file, what, usable = () => true) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { saved = undefined; }
  if (saved !== undefined && usable(saved)) return saved;
  const bad = file + '.bad-' + Date.now();
  fs.renameSync(file, bad);
  fs.chmodSync(bad, 0o600);
  log(path.basename(file) + ' could not be read; kept as ' + path.basename(bad) + ', ' + what + '.');
  return null;
}
