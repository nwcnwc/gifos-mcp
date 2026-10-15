// A local GifOS for the e2e: serves a gifos-app checkout as-is, plus a store
// listing for Meeting Bot packed from its source (it is not in the published
// catalog yet). Nothing is written into the checkout.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// Packs an app directory into an App GIF with GifOS's own encoder.
export async function packApp(appDir, siteDir, names) {
  globalThis.window = globalThis.window || globalThis;
  if (!globalThis.GifOS || !globalThis.GifOS.gif) await import(pathToFileURL(path.join(siteDir, 'js', 'gifos-gif.js')).href);
  const files = {};
  for (const n of names) {
    const p = path.join(appDir, n);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    files[n] = n.endsWith('.json') ? JSON.stringify(JSON.parse(text)) : text;
  }
  const manifest = JSON.parse(files['manifest.json']);
  const bytes = Buffer.from(await globalThis.GifOS.gif.encode(files, { accent: manifest.accent }));
  return { bytes, manifest, listing: files['listing.json'] ? JSON.parse(files['listing.json']) : {} };
}

export function listingFor(slug, manifest, listing, bytes, cover) {
  return {
    catalog: '1.0',
    slug,
    appId: manifest.appId,
    name: manifest.name,
    shortName: manifest.shortName || manifest.name,
    version: manifest.version || '1.0',
    minBuild: manifest.minBuild || 0,
    tagline: listing.tagline || manifest.description || manifest.name,
    description: listing.description || manifest.description || '',
    author: listing.author || { name: 'GifOS', url: 'https://gifos.app' },
    releaseDate: listing.releaseDate || '2026-10-14',
    updated: listing.releaseDate || '2026-10-14',
    categories: listing.categories || ['Utilities'],
    tags: listing.tags || [],
    license: listing.license || 'MIT',
    accent: manifest.accent || [92, 160, 255],
    capabilities: manifest.capabilities || {},
    cover,
    screenshots: [],
    gif: '/apps/' + slug + '/' + slug + '.gif',
    bytes: bytes.length,
    download: 0,
    provides: manifest.provides || null,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function startSite({ siteDir, port, extraApps }) {
  const overlay = new Map(); // url path -> { type, body }
  const index = JSON.parse(fs.readFileSync(path.join(siteDir, 'apps', 'index.json'), 'utf8'));
  for (const a of extraApps) {
    const app = listingFor(a.slug, a.manifest, a.listing, a.bytes, '/apps/' + a.slug + '/cover.png');
    overlay.set('/apps/' + a.slug + '/' + a.slug + '.gif', { type: 'image/gif', body: a.bytes });
    overlay.set('/apps/' + a.slug + '/app.json', { type: 'application/json', body: Buffer.from(JSON.stringify(app)) });
    overlay.set('/apps/' + a.slug + '/cover.png', { type: 'image/png', body: a.cover });
    const entry = { ...app };
    delete entry.description;
    index.apps = index.apps.filter((x) => x.slug !== a.slug).concat([entry]);
  }
  overlay.set('/apps/index.json', { type: 'application/json', body: Buffer.from(JSON.stringify(index)) });

  const root = path.resolve(siteDir);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (overlay.has(p)) {
      const o = overlay.get(p);
      res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : o.body);
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(root, '.' + p);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        const nf = path.join(root, '404.html');
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' || !fs.existsSync(nf) ? undefined : fs.readFileSync(nf));
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
