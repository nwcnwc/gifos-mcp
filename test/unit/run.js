#!/usr/bin/env node
// Runs the unit tests with TMPDIR pointed at a fresh folder, then fails if a
// test left anything in it. /tmp is a shared tmpfs with a per-user quota:
// homes that are never removed pile up across runs until unrelated writes
// fail with EDQUOT and look like flakes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-unit-tmp-'));
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: tmp },
});
const code = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(sig ? 1 : c)));
const left = fs.readdirSync(tmp);
fs.rmSync(tmp, { recursive: true, force: true });
if (left.length) {
  console.error('\nunit tests left ' + left.length + ' entries in TMPDIR (remove each home in t.after/afterEach):');
  for (const name of left.sort()) console.error('  ' + name);
  process.exit(code || 1);
}
process.exit(code);
