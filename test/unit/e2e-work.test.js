// The e2e runners make a work folder under TMPDIR (packed test apps, the MCP
// home with its Chromium profile). It must be gone when the runner exits,
// also when setup fails before the suite starts: /tmp is a shared tmpfs with
// a per-user quota, and every failed run used to leave one behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './fixtures/tmp-home.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A site that passes each runner's checks but cannot be packed from
// (no js/gifos-gif.js), so setup fails right after the work folder is made.
function brokenSite(root) {
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'apps', 'meeting-bot'), { recursive: true });
  fs.writeFileSync(path.join(site, 'apps', 'meeting-bot', 'app.json'), '{}');
  fs.writeFileSync(path.join(site, 'run.html'), '');
  return site;
}

function run(script, root) {
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const child = spawn(process.execPath, [path.join(REPO, 'test', 'e2e', script)], {
    env: {
      ...process.env,
      TMPDIR: tmp,
      GIFOS_APP_DIR: brokenSite(root),
      E2E_PROOF_DIR: path.join(root, 'proof'),
      E2E_STT: 'synthetic',
      E2E_ROOMS: '1',
      MEETING_BOT_SRC: '',
      RELAY_SCRIPT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, left: fs.readdirSync(tmp) })));
}

for (const script of ['run.js', 'load.js', 'stage-b.js']) {
  test(script + ' removes its work folder when setup fails', async () => {
    const r = await run(script, tmpHome('gifos-mcp-e2ework-'));
    assert.notEqual(r.code, 0, 'setup should fail on the broken site:\n' + r.out);
    assert.deepEqual(r.left, [], script + ' left its work folder in TMPDIR');
  });
}
