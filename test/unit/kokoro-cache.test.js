// Kokoro's weights on disk. Weights come from a local stand-in for the
// Hugging Face layout (GIFOS_KOKORO_URL), so nothing here downloads the
// real 90 MB model. Every home is removed after its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { weightsCache } from '../../src/voice/kokoro.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'fixtures', 'kokoro-child.js');
const BIN = path.join(HERE, '..', '..', 'bin', 'gifos-mcp.js');
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL = 'onnx/model_quantized.onnx';
const CONFIG = JSON.stringify({ model_type: 'style_text_to_speech_2' });

// files: name -> Buffer (served whole, or from a Range start) | { partial,
// total, bytes? } (sends the first partial bytes of total, then stalls) |
// missing (stalls with no answer). ranges lists each request's Range header.
async function weightsServer(t, files) {
  const asked = [];
  const ranges = [];
  const server = http.createServer((req, res) => {
    const prefix = '/' + REPO + '/resolve/main/';
    const name = req.url.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : req.url;
    asked.push(name);
    ranges.push({ name, range: req.headers.range || null });
    const f = files[name];
    const from = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (Buffer.isBuffer(f) && from && Number(from[1]) < f.length) {
      const start = Number(from[1]);
      res.writeHead(206, { 'content-length': f.length - start, 'content-range': 'bytes ' + start + '-' + (f.length - 1) + '/' + f.length });
      res.end(f.subarray(start));
      return;
    }
    if (Buffer.isBuffer(f)) { res.writeHead(200, { 'content-length': f.length }); res.end(f); return; }
    if (f && f.partial) {
      res.writeHead(200, { 'content-length': f.total });
      res.write(f.bytes ? f.bytes.subarray(0, f.partial) : Buffer.alloc(f.partial, 7));
      return;
    }
    // Stall: the model's own fetch stays in flight until the test ends.
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { host: 'http://127.0.0.1:' + server.address().port, asked, ranges };
}

function freshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gifos-mcp-kokoro-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const modelDir = (home) => path.join(home, 'kokoro', REPO);

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((rel) => path.join(dir, rel))
    .filter((p) => fs.statSync(p).isFile());
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for ' + what);
}

function run(file, args, env) {
  const proc = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: null };
  proc.stdout.on('data', (d) => { out.stdout += d; });
  proc.stderr.on('data', (d) => { out.stderr += d; });
  out.done = new Promise((r) => proc.on('exit', (code, signal) => { out.code = code; out.signal = signal; r(out); }));
  out.proc = proc;
  return out;
}

test('a download killed halfway leaves no model file that the next start would trust', async (t) => {
  const home = freshHome(t);
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: { partial: 300000, total: 1000000 },
  });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await until(() => filesUnder(modelDir(home)).some((p) => fs.statSync(p).size >= 300000), 20000, 'the partial model on disk');
  child.proc.kill('SIGKILL');
  await child.done;
  assert.equal(fs.existsSync(path.join(modelDir(home), MODEL)), false,
    'only a finished download may sit at the model path; found ' + JSON.stringify(filesUnder(modelDir(home)).map((p) => path.relative(home, p) + ' ' + fs.statSync(p).size)));
});

test('a model file that will not load is fetched again once, then the error is plain', async (t) => {
  const home = freshHome(t);
  // A half file from an older run that wrote straight to the model path.
  fs.mkdirSync(path.join(modelDir(home), 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir(home), 'config.json'), CONFIG);
  fs.writeFileSync(path.join(modelDir(home), MODEL), Buffer.alloc(4000, 7));
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: Buffer.alloc(4000, 9),
  });
  const child = run(CHILD, [home, w.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  const out = await Promise.race([child.done, new Promise((r) => setTimeout(() => r(null), 60000).unref())]);
  assert.ok(out, 'installKokoro settles; stderr: ' + child.stderr.slice(-2000));
  assert.equal(w.asked.filter((n) => n === MODEL).length, 1, 'the bad model is downloaded again once; asked ' + JSON.stringify(w.asked));
  assert.equal(out.code, 1, 'the load fails as a rejection, not a crash; stderr: ' + out.stderr.slice(-2000));
  const line = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(line.ok, false);
  assert.match(line.error, /Kokoro/);
});

test('the binary exits 1 with one Kokoro line when the weights will not load', async (t) => {
  const home = freshHome(t);
  fs.mkdirSync(path.join(modelDir(home), 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir(home), 'config.json'), CONFIG);
  fs.writeFileSync(path.join(modelDir(home), MODEL), Buffer.alloc(4000, 7));
  const w = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: Buffer.alloc(4000, 9),
  });
  const bin = run(BIN, [], {
    GIFOS_MCP_HOME: home, GIFOS_MCP_LAZY: '1', GIFOS_KOKORO_URL: w.host, GIFOS_URL: 'https://gifos.app',
    GIFOS_VOICE: '0', GIFOS_LLM_URL: '', GIFOS_LLM_KEY: '', GIFOS_TTS_ENGINE: '', GIFOS_TTS_URL: '', GIFOS_TTS_APP: '', GIFOS_WORKERS: '1',
  });
  t.after(() => bin.proc.kill('SIGKILL'));
  const out = await Promise.race([bin.done, new Promise((r) => setTimeout(() => r(null), 60000).unref())]);
  assert.ok(out, 'the binary exits; stderr: ' + bin.stderr.slice(-2000));
  assert.equal(out.code, 1, 'exit 1, not a crash code; stderr: ' + out.stderr.slice(-2000));
  assert.match(out.stderr, /Kokoro could not load/);
  assert.equal(/var A=void 0/.test(out.stderr), false, 'no minified phonemizer source in the log');
});

// Bytes that differ along the file, so a resume that lands at the wrong
// offset gives a different file.
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + (i >> 9)) % 251));

async function deadPid() {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.on('exit', r));
  return p.pid;
}

test('a start after a download was killed asks only for the bytes it does not have', async (t) => {
  const home = freshHome(t);
  const whole = pattern(1000000);
  const first = await weightsServer(t, {
    'config.json': Buffer.from(CONFIG),
    [MODEL]: { partial: 300000, total: whole.length, bytes: whole },
  });
  const child = run(CHILD, [home, first.host]);
  t.after(() => child.proc.kill('SIGKILL'));
  await until(() => filesUnder(modelDir(home)).some((p) => p.endsWith('.part') && fs.statSync(p).size >= 300000), 20000, 'the partial model on disk');
  child.proc.kill('SIGKILL');
  await child.done;
  const kept = filesUnder(modelDir(home)).filter((p) => p.endsWith('.part')).map((p) => fs.statSync(p).size);
  // The next start (a worker restarted after its boot ran out of time).
  const second = await weightsServer(t, { 'config.json': Buffer.from(CONFIG), [MODEL]: whole });
  const again = run(CHILD, [home, second.host]);
  t.after(() => again.proc.kill('SIGKILL'));
  await Promise.race([again.done, new Promise((r) => setTimeout(r, 60000).unref())]);
  const asks = second.ranges.filter((r) => r.name === MODEL);
  assert.ok(asks.length >= 1, 'the model is asked for; asked ' + JSON.stringify(second.ranges));
  assert.equal(asks[0].range, 'bytes=' + kept[0] + '-',
    'the first ask for the model resumes from the ' + JSON.stringify(kept) + ' bytes kept; asks ' + JSON.stringify(asks));
});

test('a resumed download puts the kept bytes and the rest together in order', async (t) => {
  const home = freshHome(t);
  const whole = pattern(1000000);
  const w = await weightsServer(t, { [MODEL]: whole });
  const dir = path.join(home, 'kokoro');
  const file = path.join(dir, REPO, MODEL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.' + (await deadPid()) + '.part', whole.subarray(0, 300000));
  const cache = weightsCache(dir, w.host);
  const res = await cache.match(w.host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.ok(res, 'the kept part is finished and answered from the cache');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(whole), 'the answer is the whole file');
  assert.ok(fs.readFileSync(file).equals(whole), 'the file on disk is the whole file');
  assert.deepEqual(w.ranges, [{ name: MODEL, range: 'bytes=300000-' }]);
  assert.deepEqual(filesUnder(path.dirname(file)).filter((p) => p.endsWith('.part')), [], 'no part file is left');
});

test('a server that ignores Range gives the whole file, not the kept bytes twice', async (t) => {
  const home = freshHome(t);
  const whole = pattern(500000);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-length': whole.length }); res.end(whole); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = 'http://127.0.0.1:' + server.address().port;
  const dir = path.join(home, 'kokoro');
  const file = path.join(dir, REPO, MODEL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.' + (await deadPid()) + '.part', whole.subarray(0, 200000));
  const res = await weightsCache(dir, host).match(host + '/' + REPO + '/resolve/main/' + MODEL);
  assert.ok(res);
  assert.ok(fs.readFileSync(file).equals(whole), 'the file on disk is the whole file');
});
