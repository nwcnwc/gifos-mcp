// The --http transport, end to end through the real binary. GIFOS_MCP_LAZY=1
// keeps the browser off: create_meeting and list_meetings never need it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'gifos-mcp.js');
const PORT = 19521;

test('streamable HTTP on 127.0.0.1 with a bearer token', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-http-'));
  const proc = spawn(process.execPath, [BIN, '--http', String(PORT)], {
    env: { ...process.env, GIFOS_MCP_HOME: home, GIFOS_MCP_LAZY: '1', GIFOS_MCP_HTTP_TOKEN: 'test-token-123', GIFOS_URL: 'https://gifos.app', GIFOS_VOICE: '0', GIFOS_LLM_URL: '', GIFOS_LLM_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => proc.kill());
  await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => { err += d; if (/listening on/.test(err)) resolve(); });
    proc.on('exit', (c) => reject(new Error('exited ' + c + ': ' + err)));
  });

  const url = new URL('http://127.0.0.1:' + PORT + '/mcp');
  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401, 'no token, no access');

  const client = new Client({ name: 'http-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer test-token-123' } } }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(tools.length, 30);
  assert.ok(names.includes('say') && names.includes('tail_transcript') && names.includes('set_voice'));
  assert.ok(names.includes('schedule_meeting') && names.includes('capacity_status'));
  const r = JSON.parse((await client.callTool({ name: 'create_meeting', arguments: { name: 'Demo meeting', admin_password: 'owner-key-77' } })).content[0].text);
  assert.match(r.link, /^https:\/\/gifos\.app\/run\.html#v=[0-9a-z]{24}$/);
  assert.equal(JSON.stringify(r).includes('owner-key-77'), false);
  const l = JSON.parse((await client.callTool({ name: 'list_meetings', arguments: {} })).content[0].text);
  assert.equal(l.meetings[0].link, r.link, 'requests share one meeting store');
  await client.close();
});
