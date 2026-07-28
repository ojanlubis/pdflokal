#!/usr/bin/env node
/*
 * Generate the OCR-LAYER PAIR — the two files that decide whether writing a
 * searchable layer is safe. Run: `node scripts/gen-fixture-ocr-layer.mjs`.
 *
 *   tests/fixtures/nasty/scan-ocr.pdf            grey page + ink bands (a scan)
 *                                                + an INVISIBLE `3 Tr` text
 *                                                layer — what OCR write-back
 *                                                would produce, if we shipped it
 *   tests/fixtures/nasty/scan-ocr-terlihat.pdf   the same file with `3 Tr`
 *                                                changed to `0 Tr` — ordinary
 *                                                VISIBLE text
 *
 * WHY A PAIR, AND WHY THEY DIFFER BY EXACTLY ONE BYTE. A lone "does it detect
 * the OCR layer" fixture is decoration: `probeTextLayer` returns true on it and
 * returns true on any normal document too, so it agrees with both the correct
 * and the broken implementation. The information is in the DIFFERENCE. These
 * two files carry the same glyphs, coordinates, font and page marks; the only
 * difference in the entire byte stream is the operand of Tr. A probe that
 * returns the same verdict for both is, by construction, not reading render
 * mode — and the generator ASSERTS the one-byte property at the bottom, so the
 * pair cannot quietly stop being a pair.
 *
 * WHY IT MATTERS (PM, 2026-07-28, reviewing the OCR spec). `probeTextLayer`
 * asks only whether text items exist with non-empty strings. Invisible text is
 * still a text item with a string — that is the whole point of a searchable
 * layer, and it is why PDF.js returns it (its own viewer needs it to make a
 * scan selectable). So writing a searchable layer would flip `text_layer` to
 * true on precisely the documents Edit must keep declining. Edit would then cut
 * the INVISIBLE show-ops — no visible change, because they were never visible —
 * and stamp the replacement over an untouched scan image. The original stays on
 * the page and the new text lands beside it: `: Pondok Sapi, : Cibeber,`, the
 * live incident of 2026-07-28, manufactured deliberately on every document we
 * had just "helped".
 *
 * `js/core/text-walk.js` is blind to Tr in the same way — it tracks
 * Tc Tw Tz TL Ts Tf Tm Td TD T* Tj TJ ' " and no Tr — so the cut step cannot
 * save us either. Two layers, one blind spot.
 *
 * WHY HAND-BUILT rather than pdf-lib like its siblings: `page.pushOperators`
 * did not survive `save()` here (the output carried `q`, `Q` and an EMPTY
 * content stream, with the pushed ops nowhere in the file), and pdf-lib's
 * high-level `drawText` cannot set a render mode at all. Hand-writing also buys
 * the property this fixture exists for: uncompressed streams, so the pair
 * differs by one literal byte and the difference is legible in any text editor
 * without tooling that could itself be wrong.
 *
 * WHY THE INK BANDS: they stand in for the scanned pixels of the original
 * words. They are visible marks that are NOT text operators — exactly what a
 * scan is, and exactly what Edit's cut step cannot remove.
 *
 * WHY "Pondok Sapi": it is what the founder saw duplicated on 2026-07-28. If
 * this ever regresses, the failure output should read like the bug report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'tests/fixtures/nasty');

// The page: a grey sheet, two bands of "ink" where the scanned words sit, and a
// text layer positioned over them. `%%TR%%` is the single byte under test.
const content = `0.87 0.87 0.85 rg
0 0 595 842 re f
0.12 0.12 0.12 rg
72 697 108 13 re f
72 673 66 13 re f
BT
%%TR%% Tr
/F1 12 Tf
1 0 0 1 72 700 Tm
(Pondok Sapi) Tj
1 0 0 1 72 676 Tm
(Cibeber) Tj
ET
`;

function buildPdf(stream) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];

  let pdf = '%PDF-1.7\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const files = [['3', 'scan-ocr.pdf'], ['0', 'scan-ocr-terlihat.pdf']];
for (const [mode, name] of files) {
  const bytes = buildPdf(content.replace('%%TR%%', mode));
  fs.writeFileSync(path.join(OUT, name), bytes);
  console.log(`${name.padEnd(24)} ${mode} Tr  ${bytes.length} bytes`);
}

// PROVE THE PAIR IS A PAIR. A generator that emitted the same file twice, or
// that drifted into changing more than the render mode, would make every test
// downstream vacuous — and they would all still pass.
const [a, b] = files.map(([, n]) => fs.readFileSync(path.join(OUT, n)));
if (a.length !== b.length) throw new Error(`lengths differ (${a.length} vs ${b.length}) — expected one operand`);
const diffs = [...a].reduce((acc, byte, i) => (byte === b[i] ? acc : [...acc, i]), []);
if (diffs.length !== 1) throw new Error(`${diffs.length} bytes differ — the pair must differ by exactly one`);
const [at] = diffs;
if (String.fromCharCode(a[at]) !== '3' || String.fromCharCode(b[at]) !== '0') {
  throw new Error(`byte ${at} is ${JSON.stringify(String.fromCharCode(a[at]))}/${JSON.stringify(String.fromCharCode(b[at]))}, not the Tr operand`);
}
console.log(`pair verified: identical except byte ${at} — '3' vs '0', the Tr operand`);
