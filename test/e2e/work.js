// A work folder under TMPDIR that is removed however the runner exits:
// a failed setup, process.exit from a check, an uncaught error, Ctrl-C or
// SIGTERM. /tmp is a shared tmpfs with a per-user quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
let hooked = false;

function removeAll() {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort at exit */ }
  }
}

export function workDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAll);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      process.once(sig, () => { removeAll(); process.exit(code); });
    }
  }
  return dir;
}
