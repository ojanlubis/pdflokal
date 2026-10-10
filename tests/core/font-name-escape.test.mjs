/*
 * A FONT RESOURCE NAME WITH A #xx ESCAPE IS FOUND BY ITS Tf OPERAND.
 * ============================================================================
 * The tokenizer decodes `/A#20B Tf` to "A B"; redact.js keyed its font map with
 * pdf-lib's ENCODED form "A#20B". The lookup missed, the font read as unknown,
 * and every Edit/Hapus target in that font declined. Both sides now decode
 * with content-stream.js's one decodeName.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFontMetrics } from '../../js/core/redact.js';
import { tokenizeOps } from '../../js/core/content-stream.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

test('extractFontMetrics keys an escaped resource name exactly as the Tf operand decodes', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  await doc.save(); // flushes the embedded font to its ref
  const fontDict = doc.context.obj({});
  fontDict.set(PDFLib.PDFName.of('A B'), font.ref);
  page.node.Resources().set(PDFLib.PDFName.of('Font'), fontDict);

  const [tf] = tokenizeOps('/A#20B 12 Tf').filter((o) => o.op === 'Tf');
  const operand = tf.tokens.find((t) => t.t === 'name').v;
  assert.equal(operand, 'A B', 'known-positive: the tokenizer decodes the operand');
  const metrics = extractFontMetrics(page, PDFLib);
  assert.ok(metrics.size > 0, 'the instrument found no fonts at all');
  assert.ok(metrics.has(operand), `font map keys ${JSON.stringify([...metrics.keys()])} miss the operand "${operand}"`);
});
