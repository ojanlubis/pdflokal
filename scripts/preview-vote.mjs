#!/usr/bin/env node
/*
 * PDFLokal — scripts/preview-vote.mjs  (DEV ONLY: look at the feature vote on your own machine)
 * ============================================================================
 *   node scripts/preview-vote.mjs            # http://localhost:5252
 *   PORT=5300 node scripts/preview-vote.mjs
 *   node scripts/preview-vote.mjs --empty    # no demo ballots: the card says only thanks
 *
 * Serves this folder as static files (the way `vercel dev` would: clean URLs, `/en`
 * is en/index.html) AND answers the vote's own endpoints with the REAL handlers
 * (api/votes.js, api/feedback.js) running on an IN-MEMORY SQLite that has the real
 * migration applied (scripts/turso-feedback-migration.sql). So the one-ballot-per-
 * visitor rule you see here is the production rule, not a mock of it. Everything
 * else under /api answers 204 (telemetry, rev, visitors: nothing is stored).
 *
 * Needs Node 22.13+ (node:sqlite). Nothing is written anywhere but memory: stop the
 * process and the ballots are gone. NEVER SERVED IN PRODUCTION: /scripts is in
 * .vercelignore, and nothing imports this file.
 *
 *   /__reset   clears the demo ballots AND this browser's vote memory, then goes home
 *              (so you can vote again: the real rule is one ballot per visitor_id).
 *
 * To see the card without downloading: the "Usulkan fitur" link in the header (or the
 * menu, on a phone). To see the download moment: open a PDF, Unduh, wait ~5s.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5252;
const EMPTY = process.argv.includes('--empty');

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'scripts', 'turso-feedback-migration.sql'), 'utf8'));

function seed() {
  if (EMPTY) return;
  // 14 made-up ballots (api/votes.js shows a ranking only from 10 voters up).
  const ins = db.prepare('insert into feature_ballots (visitor_id, lang, has_text, features) values (?, ?, ?, ?)');
  const picks = [
    ['pdf-word', 'save-edits'], ['pdf-word', 'watermark'], ['pdf-word', 'lock-unlock', 'save-edits'], ['save-edits'],
    ['pdf-word', 'pdf-excel'], ['save-edits', 'form-fill'], ['pdf-word'], ['watermark', 'save-edits'],
    ['pdf-word', 'camera-scan'], ['lock-unlock'], ['pdf-word', 'save-edits', 'canvas-image'], ['pdf-excel', 'pdf-word'],
    ['save-edits'], ['pdf-word', 'watermark'],
  ];
  picks.forEach((p, i) => ins.run(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, 'id', 0, JSON.stringify(p)));
}
seed();

// The handlers' own test seam, backed by the real SQLite: the endpoint's own SQL runs on it.
const seam = async (sql, values) => {
  const stmt = db.prepare(sql);
  if (/^\s*(select|with)\b/i.test(sql)) return { rows: stmt.all(...values).map((r) => Object.values(r)) };
  return { rowCount: Number(stmt.run(...values).changes) };
};
const votes = await import(pathToFileURL(path.join(ROOT, 'api', 'votes.js')));
const feedback = await import(pathToFileURL(path.join(ROOT, 'api', 'feedback.js')));
votes.__setDbForTests(seam);
feedback.__setQueryForTests(seam);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json',
};

function shim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  return res;
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const candidates = [rel, `${rel}.html`, path.posix.join(rel, 'index.html')];
  for (const c of candidates) {
    const file = path.normalize(path.join(ROOT, c));
    // stay inside the folder, and never serve dotfiles (.git, .env)
    if (!file.startsWith(ROOT + path.sep) || file.split(path.sep).some((p) => p.startsWith('.'))) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

const server = http.createServer(async (req, res) => {
  shim(res);
  const pathname = (req.url || '/').split('?')[0];
  try {
    if (pathname === '/__reset') {
      db.exec('delete from feature_ballots; delete from feature_requests;');
      seed();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><script>'
        + 'for (const k of ["pdflokal_vote_done","pdflokal_vote_nanti","pdflokal_vote_ids","pdflokal_vote_told"]) localStorage.removeItem(k);'
        + 'location.replace("/");</script>Reset.');
      return;
    }
    if (pathname === '/api/votes') { await votes.default(req, res); return; }
    if (pathname === '/api/feedback') {
      await feedback.default(req, res);
      const n = db.prepare('select count(*) n from feature_requests').get().n;
      if (n) console.log(`[preview] ideas filed so far: ${n}`);
      return;
    }
    if (pathname.startsWith('/api/')) { res.writeHead(204); res.end(); return; }
    serveStatic(req.url || '/', res);
  } catch (err) {
    console.error('[preview] error', err?.name);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`pdflokal vote preview: http://localhost:${PORT}   (in-memory; /__reset to vote again${EMPTY ? '; no demo ballots' : '; 14 demo ballots'})`);
});
