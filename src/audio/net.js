// Small HTTP helpers shared by the speech engines. Redirects are followed.
// Downloads land in GIFOS_MCP_HOME and are never committed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

export function requestBuf(url, opts = {}) {
  return open(url, opts, 0).then((got) => readAll(got.res).then((body) => ({
    status: got.status, headers: got.headers, body,
  })));
}

function open(url, opts, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body || null;
    if (body && headers['Content-Length'] == null) headers['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request(u, { method: opts.method || 'GET', headers, timeout: opts.timeout || 120000 }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const method = code === 303 ? 'GET' : (opts.method || 'GET');
        resolve(open(next, {
          method,
          headers: method === 'GET' ? {} : headers,
          body: method === 'GET' ? null : body,
          timeout: opts.timeout,
        }, redirects + 1));
        return;
      }
      resolve({ status: code, headers: res.headers, res });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    if (body) req.write(body);
    req.end();
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

export function looksAudio(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  if (!buf || buf.length < 4) return false;
  const m = buf.subarray(0, 4).toString('ascii');
  if (m === 'RIFF' || m === 'OggS' || m === 'fLaC') return true;
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

const inflight = new Map();

// Download url to dest once. A file already larger than minBytes is kept.
export function downloadFile(url, dest, { minBytes = 1024, log } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) return Promise.resolve(dest);
  if (inflight.has(dest)) return inflight.get(dest);
  const p = (async () => {
    if (log) log('downloading ' + path.basename(dest));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const res = await requestBuf(url, { timeout: 600000 });
    if (res.status >= 300) throw new Error('download ' + res.status + ' ' + url);
    if (res.body.length < minBytes) throw new Error('download too small (' + res.body.length + ' bytes): ' + url);
    const tmp = dest + '.partial';
    fs.writeFileSync(tmp, res.body);
    fs.renameSync(tmp, dest);
    return dest;
  })();
  inflight.set(dest, p);
  p.finally(() => { if (inflight.get(dest) === p) inflight.delete(dest); });
  return p;
}

export function multipartFile(fileBuf, { filename = 'audio.wav', type = 'audio/wav', fields = {} } = {}) {
  const boundary = '----gifos' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}
