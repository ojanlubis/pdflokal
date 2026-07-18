/*
 * Rung B lab — content-stream tokenizer + show-op remover (headless).
 * The tokenizer must never miscount a string boundary: one off-by-one here
 * corrupts a page. These tests pin the gnarly cases (escapes, nested parens,
 * hex, TJ arrays, dicts, comments) before any browser wiring trusts it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeOps, removeShowOps, decodeLiteralString } from '../../js/core/content-stream.js';

test('decodes literal string escapes (octal, specials, nested escapes)', () => {
  assert.equal(decodeLiteralString('Nomor\\: 123'), 'Nomor: 123');
  assert.equal(decodeLiteralString('a\\(b\\)c'), 'a(b)c');
  assert.equal(decodeLiteralString('tab\\there'), 'tab\there');
  assert.equal(decodeLiteralString('\\101BC'), 'ABC'); // octal 101 = A
});

test('tokenizes a simple text block into op records', () => {
  const src = 'BT /F1 12 Tf 72 700 Td (Halo Dunia) Tj ET';
  const ops = tokenizeOps(src).map((o) => o.op);
  assert.deepEqual(ops, ['BT', 'Tf', 'Td', 'Tj', 'ET']);
});

test('strings survive nested parens and escaped parens', () => {
  const src = '(a (nested) string) Tj ((deep \\( escape)) Tj';
  const ops = tokenizeOps(src);
  assert.equal(ops[0].strings[0], 'a (nested) string');
  assert.equal(ops[1].strings[0], '(deep ( escape)');
});

test('TJ arrays concatenate their string elements; kerning numbers ignored', () => {
  const src = '[(Su) -20 (rat) 15 ( Resmi)] TJ';
  const ops = tokenizeOps(src);
  assert.equal(ops[0].op, 'TJ');
  assert.equal(ops[0].strings.join(''), 'Surat Resmi');
});

test('hex strings decode', () => {
  const src = '<48616C6F> Tj';
  assert.equal(tokenizeOps(src)[0].strings[0], 'Halo');
});

test('dicts, comments, and gs ops pass through untouched', () => {
  const src = '% comment with (parens) and Tj\n/GS0 gs << /Type /X >> BDC (real) Tj EMC';
  const ops = tokenizeOps(src).map((o) => o.op);
  assert.deepEqual(ops, ['gs', 'BDC', 'Tj', 'EMC']);
});

test('removeShowOps removes exactly the matched op, keeps everything else byte-safe', () => {
  const src = 'BT /F1 12 Tf 72 700 Td (Rahasia) Tj 0 -20 Td (Aman) Tj ET';
  const { content, removed } = removeShowOps(src, ({ text }) => text === 'Rahasia');
  assert.equal(removed, 1);
  assert.ok(!content.includes('(Rahasia) Tj'));
  assert.ok(content.includes('(Aman) Tj'));
  assert.ok(content.includes('0 -20 Td')); // positioning survives
  // The result must itself re-tokenize cleanly (no boundary corruption).
  const ops = tokenizeOps(content).map((o) => o.op);
  assert.deepEqual(ops, ['BT', 'Tf', 'Td', 'Td', 'Tj', 'ET']);
});

test('removeShowOps handles TJ and quote ops', () => {
  const src = "(line one) ' [(li) (ne two)] TJ (keep) Tj";
  const { content, removed } = removeShowOps(src, ({ text }) => text.includes('line') || text === 'line two');
  assert.equal(removed, 2);
  assert.ok(content.includes('(keep) Tj'));
});

test('no match → identical content, zero removed', () => {
  const src = 'BT (x) Tj ET';
  const r = removeShowOps(src, () => false);
  assert.equal(r.removed, 0);
  assert.equal(r.content, src);
});

test('stray closers never hang the tokenizer (the infinite-loop guard)', () => {
  const src = ') > (ok) Tj';
  const ops = tokenizeOps(src);
  assert.equal(ops[0].op, 'Tj');
  assert.equal(ops[0].strings[0], 'ok');
});
