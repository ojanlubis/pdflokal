#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/label-tebal.pdf — the BOLD-LABEL / REGULAR-VALUE
 * form row. Run: `node scripts/gen-fixture-labelvalue.mjs`.
 *
 * WHY this fixture exists: `Nama : Budi Santoso` — a bold label followed by a
 * regular value on ONE baseline — is the archetypal Indonesian form row, and
 * it is the shape that exposes a defect none of our existing fixtures can see.
 *
 * The defect (found 2026-07-28 while gating the dash-leader fix): there are TWO
 * different answers to "what font is this line" living in one flow.
 *   - core/text-lines.js's assembleLine picks the DOMINANT run — widest by
 *     pdf.len. Here that is the regular value.
 *   - core/text-walk.js's planRunRemoval picks the FIRST BY CONTENT-STREAM
 *     POSITION for its `insert` block
 *     (`matches.reduce((a, b) => a.start <= b.start ? a : b)`). Here that is
 *     the bold label.
 * js/v2/app.js's prepareDocFont consumes the second while everything
 * downstream assumes the first, then does `draft.bold = draft.bold || fp.bold`
 * — so ANY line whose first-painted run is bold bolds the ENTIRE replacement.
 * Measured on this exact geometry: learned MontserratThin-Bold (bold:true)
 * while text-lines.js called the same line Carlito-Regular. And because a
 * genuinely mixed-font line makes the native stamp decline, the twin fallback
 * renders using that wrong flag — visible in the output, not just the draft.
 *
 * WHY NOT reuse formulir-garis.pdf: it structurally CANNOT expose this. Its
 * generator paints both the label and the dash leader with the same /F1
 * resource, so the learned font name is identical whichever run is chosen —
 * the fixture cannot distinguish the two answers, which makes it decoration
 * for this question rather than coverage. Same lesson as the QA gate: an
 * assertion that cannot come out differently proves nothing.
 *
 * WHY these two font programs: montserrat-bold.woff2 and carlito-regular.woff2
 * are both REAL repo assets already shipped in fonts/ (no new licensed asset),
 * and they are genuinely different families, so the two runs land in genuinely
 * different /Font resources — which is the whole point. Same pairing
 * tests/core/page-surgery-mixedfonts.test.mjs already builds inline; this
 * script makes it a file so the Playwright suite can drive the REAL UI over it,
 * which is where prepareDocFont actually runs.
 *
 * pdf-lib's own embedFont() is fine here (unlike gen-fixture-word.mjs, which
 * needed hand-built objects to force a simple-TrueType shape). This defect is
 * about WHICH resource is chosen, not about the resource's own shape, so the
 * Type0 fonts embedFont emits are exactly right.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

const SIZE = 12;
const LEFT = 72;

const doc = await PDFLib.PDFDocument.create();
doc.registerFontkit(fontkit);

const bold = await doc.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-bold.woff2'))));
const regular = await doc.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2'))));

const page = doc.addPage([595, 842]);

// Heading — single font, so a tap here exercises the ordinary path and gives
// the suite a control line on the same page.
page.drawText('FORMULIR PENDAFTARAN', {
  x: LEFT, y: 770, size: 20, font: bold, color: PDFLib.rgb(0, 0, 0),
});

// THE SUBJECT LINE. Bold label painted FIRST (so it wins first-by-stream),
// regular value painted second and WIDER (so it wins dominant-by-width). The
// two selectors therefore disagree — that disagreement is the fixture.
const label = 'Nama : ';
page.drawText(label, { x: LEFT, y: 700, size: SIZE, font: bold, color: PDFLib.rgb(0, 0, 0) });
page.drawText('Budi Santoso Wijaya', {
  x: LEFT + bold.widthOfTextAtSize(label, SIZE), y: 700, size: SIZE, font: regular, color: PDFLib.rgb(0, 0, 0),
});

// Sibling rows, single-font, so a test can prove surgery stayed scoped to the
// line it was given rather than passing by having flattened the page.
page.drawText('Alamat : Jalan Merdeka 17', {
  x: LEFT, y: 670, size: SIZE, font: regular, color: PDFLib.rgb(0, 0, 0),
});
page.drawText('Tanggal : 19 Juli 2026', {
  x: LEFT, y: 640, size: SIZE, font: regular, color: PDFLib.rgb(0, 0, 0),
});

const bytes = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/label-tebal.pdf');
fs.writeFileSync(dest, bytes);

console.log(`wrote ${path.relative(root, dest)} (${bytes.length} bytes)`);
console.log(`  subject line: bold "${label.trim()}" (first by stream) + regular value (dominant by width)`);
console.log('  the two "which font is this line" selectors disagree here — that IS the fixture');
