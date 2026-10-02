/*
 * scripts/docx-gate.mjs: the scoring gate's pure parts, and its own proof that it can go red.
 * No corpus needed (the corpus is gitignored and absent in CI): this pins the INSTRUMENT, so that a
 * lane's "gate is green" means something. The real run is `node scripts/docx-gate.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compareRuns, summarize, tokens, recall, HEADLINE, loadBaseline } from '../../scripts/docx-gate.mjs';
import { root } from './docx-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

const row = (id, over = {}) => ({ id, ok: 1, recallBag: 1, recallLcs: 1, recallBagPoppler: 1, recallLcsPoppler: 1, recallRendered: 1, visGrid: 0.9, visBody: 0.9, pageRatio: 1, docxBold: 2, pdfBold: 2, docxItalic: 0, pdfItalic: 0, docxDrawings: 3, docxShapes: 0, docxTables: 1, xmlOk: 1, pkgOk: 1, renderOk: 1, msPerPage: 20, rssMB: 200, linePerParaFlag: 0, ...over });

test('gate: tokens/recall measure words and order, and know the difference', () => {
  assert.deepEqual(tokens('Halo, Dunia! 123'), ['halo', 'dunia', '123']);
  const w = tokens('satu dua tiga empat lima enam');
  assert.deepEqual([recall(w, w).bag, recall(w, w).lcs], [1, 1]);
  const shuffled = ['enam', 'lima', 'empat', 'tiga', 'dua', 'satu'];
  assert.equal(recall(w, shuffled).bag, 1);
  assert.ok(recall(w, shuffled).lcs < 0.4);
  assert.equal(recall(w, []).bag, 0);
});

test('gate: summarize is over exactly the rows given, and counts what the headline needs', () => {
  const s = summarize([row('a'), row('b', { ok: 0, recallBag: null }), row('c', { xmlOk: 0 }), row('d', { renderOk: 0 })]);
  assert.equal(s.n, 4);
  assert.equal(s.failures, 1);
  assert.equal(s.xmlBad, 1);
  assert.equal(s.renderFail, 1);
  assert.equal(s.tables, 4);
  assert.equal(s.pictures, 12);
  assert.equal(s.boldKept, 1);
});

test('gate: every headline metric has a way to go red (a tolerance and a direction)', () => {
  for (const h of HEADLINE) {
    assert.ok(h.better === 'higher' || h.better === 'lower', h.id);
    assert.ok(h.abs !== undefined || h.rel !== undefined, h.id);
    assert.equal(typeof h.get, 'function');
  }
  assert.equal(new Set(HEADLINE.map((h) => h.id)).size, HEADLINE.length);
});

test('gate: compare passes an identical run and an improvement, fails each regression, and reports a perf slowdown without --no-perf failing it', () => {
  const base = { a: row('a'), b: row('b', { docxTables: 0 }) };
  const clone = () => JSON.parse(JSON.stringify(base));
  assert.equal(compareRuns(clone(), base).pass, true);
  const better = clone(); better.b.docxTables = 6; better.a.visGrid = 0.95;
  assert.equal(compareRuns(better, base).pass, true);
  for (const [what, mutate] of [
    ['conversion failure', (c) => { c.a.ok = 0; }],
    ['malformed XML', (c) => { c.b.xmlOk = 0; }],
    ['broken package', (c) => { c.b.pkgOk = 0; }],
    ['render failure', (c) => { c.a.renderOk = 0; }],
    ['one file loses its words', (c) => { c.a.recallBag = 0.6; }],
    ['ordering drifts everywhere', (c) => { c.a.recallLcs = 0.9; c.b.recallLcs = 0.9; }],
    ['pictures vanish', (c) => { c.a.docxDrawings = 0; }],
    ['tables vanish', (c) => { c.a.docxTables = 0; }],
    ['bold vanishes', (c) => { c.a.docxBold = 0; c.b.docxBold = 0; }],
    ['pagination doubles', (c) => { c.a.pageRatio = 2; c.b.pageRatio = 2; }],
    ['memory +50%', (c) => { c.a.rssMB = 300; }],
  ]) {
    const c = clone(); mutate(c);
    assert.equal(compareRuns(c, base).pass, false, what);
  }
  const slow = clone(); slow.a.msPerPage = 80; slow.b.msPerPage = 80;
  assert.equal(compareRuns(slow, base).pass, false);
  assert.equal(compareRuns(slow, base, { perf: false }).pass, true);
});

test('gate: a subset is compared against the SAME files in the baseline, not against the whole', () => {
  const base = { a: row('a', { recallLcs: 0.5 }), b: row('b', { recallLcs: 1 }), c: row('c', { recallLcs: 1 }) };
  const cur = { b: row('b', { recallLcs: 1 }) };
  const cmp = compareRuns(cur, base);
  assert.equal(cmp.ids, 1);
  assert.equal(cmp.pass, true);
  assert.equal(compareRuns({ z: row('z') }, base).ids, 0);
});

test('gate: --render off makes the render metrics n/a, not red', () => {
  const base = { a: row('a') };
  const cur = { a: row('a', { renderOk: null, recallRendered: null, visGrid: null, visBody: null, pageRatio: null }) };
  const cmp = compareRuns(cur, base, { render: false });
  assert.equal(cmp.pass, true);
  assert.ok(cmp.checks.filter((c) => /render|visual|pagination/.test(c.label)).every((c) => /^n\/a/.test(c.status)));
});

test('gate: the committed baseline loads, covers the corpus, and holds ids and numbers only', () => {
  const file = path.join(root, 'scripts/docx-baseline.json');
  const b = loadBaseline(file);
  const ids = Object.keys(b.rows);
  assert.ok(ids.length >= 100, `${ids.length} baseline rows`);
  assert.ok(ids.every((id) => /^n\d+$/.test(id)));
  for (const r of Object.values(b.rows)) for (const v of Object.values(r)) assert.ok(v === null || typeof v === 'number' || ['text-born', 'searchable-scan', 'scan', 'yes', 'no'].includes(v), `unexpected value ${v}`);
  assert.equal(compareRuns(b.rows, b.rows).pass, true, 'the baseline passes against itself');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\.pdf|bodyHead|notes/);
});

test('gate: --self-test exits 0 (the instruments and the exit code can go red)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/docx-gate.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test passed/);
});
