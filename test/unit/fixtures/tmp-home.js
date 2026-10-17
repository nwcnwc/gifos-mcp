// A fresh home folder under TMPDIR that is removed once the test file is done.
// /tmp is a shared tmpfs with a per-user quota; homes left behind by every run
// fill it until unrelated writes fail (npm test checks this, see run.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const homes = [];
after(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

export function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  homes.push(home);
  return home;
}
