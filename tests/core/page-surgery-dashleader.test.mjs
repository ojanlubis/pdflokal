/*
 * page-surgery-dashleader.test.mjs — the dash-leader form-row regression
 * (founder field report 2026-07-28).
 * ============================================================================
 * A real 21+-page consent-gated PDF: the user tapped a form row shaped
 * `Alamat : Pondok Sapi, ` followed by a dashed leader running to the right
 * margin, and retyped it. Telemetry said `surgery {matched:true,
 * reason:'clean'}` — but the before/after raster crops proved the ORIGINAL
 * text was never removed, and the replacement was stamped mid-leader instead
 * of at the line's own start.
 *
 * MECHANISM (see scripts/gen-fixture-formrow.mjs's own header for the full
 * derivation): the form row is TWO content-stream show-ops sharing one
 * baseline — the label/value text, then the dash leader at a materially
 * different point size (real forms often set leaders bigger for visual
 * weight). core/text-lines.js's groupRunsIntoLines correctly clusters both
 * into ONE Line (same baseline), but its `pdf` field (the merged geometry
 * js/v2/app.js used to feed core/text-walk.js as the WHOLE line's surgery
 * target) takes its `size` from the DOMINANT run — the widest one, always
 * the leader here, since it paints all the way to the margin. Feeding that
 * ONE blended target into planRunRemoval's per-target `sizeOk` gate
 * ([0.55, 1.8] x target.size) rejects the label/value op (wrong size) while
 * accepting the leader op trivially — only the leader gets cut, the real
 * text survives, and the native re-insert's origin sits at the leader's own
 * start (i.e. where the untouched original text visually ENDS).
 *
 * FIX: js/v2/app.js's smartReplace now feeds core/page-surgery.js ONE TARGET
 * PER CONSTITUENT RUN (`line.runs.map((r) => r.pdf)`) instead of one blended
 * target — each run keeps its OWN size/position, so text-walk.js's existing
 * per-target sizeOk gate correctly isolates and cuts EACH run's own show-op,
 * with no code change needed in text-walk.js/redact.js at all (the array-of-
 * targets plumbing already existed for exactly this "a line can span more
 * than one content-stream cut" case — see page-surgery.js's own runSurgery
 * docstring). core/page-surgery.js gained one defensive addition: the
 * INSERT step's `mixedFonts` decline (stamp natively only when every cut op
 * shares one font) now aggregates across ALL of a candidate's targets, not
 * just within one — without that, per-run targets would silently lose the
 * "decline native stamp when the line's runs are genuinely different fonts"
 * protection (text-lines.test.mjs's own "dominant style" case), reintroducing
 * a sibling instance of this exact defect CLASS (a confident wrong font
 * instead of a confident wrong cut). See page-surgery-mixedfonts.test.mjs for
 * that regression's own coverage.
 *
 * Same helper shapes as page-surgery-edited.test.mjs (buildDocFromFixture,
 * fontDictOf) — this suite adds its own line-clustering + ganti-pair helpers
 * since the input here is a TWO-RUN line, not a single-run target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildEditedPageBytes } from '../../js/core/page-surgery.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);
const FIXTURE = 'formulir-garis.pdf';

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

async function buildDocFromFixture(PDFLib, fixtureName) {
  const bytes = fs.readFileSync(NASTY(fixtureName));
  const srcPdfDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcPdfDoc.getPages()[0];
  const { width, height } = srcPage.getSize();

  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: fixtureName, bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  return { doc, page, srcPage, bytes };
}

// walkShowOps' records -> js/v2/text-runs.js-shaped Run[] (the exact fields
// core/text-lines.js's groupRunsIntoLines reads: str + pdf.{x0,y0,ux,uy,len,
// size} + fontName). Display-space x/y/w/h are never read by groupRunsIntoLines
// itself, only by resolveTap (not exercised here) — filled with harmless
// placeholders so the shape still matches text-runs.js's real output.
function recordsToRuns(records, fonts) {
  return records
    .filter((r) => r.tokens.some((t) => t.t === 'str'))
    .map((r) => {
      const font = fonts.get(r.fontName);
      const strTok = r.tokens.find((t) => t.t === 'str');
      // Decode the latin1-ish literal back to its ASCII string — this
      // fixture's text is plain ASCII (WinAnsiEncoding, single-byte codes),
      // so the tokenizer's raw string IS the readable text already.
      const str = strTok.v;
      return {
        str,
        x: r.x, y: r.y, w: r.advanceText ?? 0, h: r.size,
        size: r.size,
        fontName: r.fontName,
        fontFamily: '',
        pdf: {
          x0: r.x, y0: r.y, ux: r.ux, uy: r.uy, len: r.advanceText ?? 0, size: r.size,
        },
      };
    });
}

function fontDictOf(PDFLib, pdfPage) {
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const resources = pdfPage.node.Resources();
  if (!resources) return null;
  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return null;
  const fontDict = fontDictRaw instanceof PDFRef ? pdfPage.doc.context.lookup(fontDictRaw) : fontDictRaw;
  return fontDict instanceof PDFDict ? fontDict : null;
}

// The "ganti" pair, same shape page-surgery-edited.test.mjs's addGantiPair
// builds — replaceTargets is the one field this suite varies (a single
// blended target vs. one target per constituent run).
function addGantiPair(doc, page, replaceTargets, replacementText) {
  const rect = { x: 72, y: 686, width: 300, height: 20 };
  const cover = model.createAnnotation('whiteout', {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    replaceTargets,
    replaceBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  });
  ops.addAnnotation(doc, page.id, cover);
  const text = model.createAnnotation('text', {
    x: rect.x, y: rect.y, width: 200, height: 20,
    text: replacementText, fontFamily: 'Helvetica', fontSize: 12, color: '#000000',
    replaceCoverId: cover.id,
  });
  ops.addAnnotation(doc, page.id, text);
  return { cover, text };
}

async function deriveLine(srcPage, PDFLib) {
  const fonts = extractFontMetrics(srcPage, PDFLib);
  const content = readPageContents(srcPage, PDFLib);
  const records = walkShowOps(content, fonts);
  const runs = recordsToRuns(records, fonts);
  const lines = groupRunsIntoLines(runs);
  // Line B: "Alamat : Pondok Sapi, " + the dash leader — the only 2-run line.
  const line = lines.find((l) => l.runs.length === 2);
  return { line, records, content, fonts };
}

test('mechanism check: the merged Line takes its size from the dash leader (the dominant/widest run), not the label text', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const { srcPage } = await buildDocFromFixture(PDFLib, FIXTURE);
  const { line } = await deriveLine(srcPage, PDFLib);

  assert.ok(line, 'expected Line B (label text + dash leader) to cluster into one Line');
  assert.equal(line.runs.length, 2);
  const [textRun, leaderRun] = [...line.runs].sort((a, b) => a.pdf.len - b.pdf.len);
  assert.ok(leaderRun.pdf.len > textRun.pdf.len, 'the dash leader must be the widest run');
  assert.equal(Math.round(line.pdf.size), Math.round(leaderRun.pdf.size));
  assert.notEqual(Math.round(line.pdf.size), Math.round(textRun.pdf.size));
});

test('REGRESSION (was failing): Ganti Teks on a dash-leader form row must not leave the original text behind', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, srcPage, bytes } = await buildDocFromFixture(PDFLib, FIXTURE);
  const { line } = await deriveLine(srcPage, PDFLib);

  // The FIXED construction: one surgery target PER constituent run
  // (js/v2/app.js's smartReplace, post-fix) — not one blended target.
  const replaceTargets = line.runs.map((r) => r.pdf);
  const { cover, text } = addGantiPair(doc, page, replaceTargets, 'Alamat : Cibeber, ');

  const origFontKeys = (fontDictOf(PDFLib, srcPage)?.keys() ?? []).map((k) => k.toString());
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const result = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });

  assert.ok(result.bytes, 'expected edited bytes when the edit applied');
  assert.deepEqual(result.declined, []);
  assert.ok(result.applied.has(cover.id), 'surgery should have succeeded for the cover');
  assert.ok(result.applied.has(text.id), 'the replacement should have been written natively');

  // The honest-signal requirement: 'clean' must mean the WHOLE target's
  // painted content is actually gone, not "a match was found somewhere".
  assert.equal(result.outcomes.length, 1);
  assert.deepEqual(result.outcomes[0].surgery, { matched: true, reason: 'clean' });
  assert.equal(result.outcomes[0].insert.path, 'native');
  assert.equal(result.outcomes[0].insert.reason, 'clean');

  const outPdfDoc = await PDFLib.PDFDocument.load(result.bytes);
  const outPage = outPdfDoc.getPages()[0];
  const outContent = readPageContents(outPage, PDFLib);
  const outFonts = extractFontMetrics(outPage, PDFLib);
  const outRecords = walkShowOps(outContent, outFonts);

  // THE CORE ASSERTION: the original label/value text is genuinely absent —
  // no show op anywhere in the export still carries its string.
  const originalSurvives = outRecords.some(
    (r) => r.tokens.some((t) => t.t === 'str' && t.v.includes('Pondok Sapi')),
  );
  assert.equal(originalSurvives, false, 'the original "Pondok Sapi" text must not survive the replace');

  // The dash leader is gone too — it was part of the SAME edited line.
  const leaderSurvives = outRecords.some(
    (r) => r.tokens.some((t) => t.t === 'str' && t.v.includes('----')),
  );
  assert.equal(leaderSurvives, false, 'the dash leader must not survive the replace either');

  // The replacement landed at the LABEL's own origin (the first run's start),
  // not at the leader's start (the untouched-original's visual END) — the
  // second symptom of the original defect. A native stamp is pdf-lib's own
  // embedFont (Type0/Identity-H, CID-keyed) even for a simple-TrueType
  // source program, so the operand is glyph-id bytes, not readable ASCII —
  // matched here by its FRESH font resource (a native/clone stamp always
  // registers a new /Font key, see export-parity.test.mjs's own note) rather
  // than by string content.
  const replacementRec = outRecords.find((r) => r.fontName !== 'F1' && r.tokens.some((t) => t.t === 'str'));
  assert.ok(replacementRec, 'expected the replacement text to be stamped natively');
  assert.equal(Math.round(replacementRec.x), 72);
  assert.equal(Math.round(replacementRec.y), 690);

  // Sibling lines (heading, Nama, Tanggal) survive byte-identical — surgery
  // only touched Line B's own two show-ops.
  assert.ok(outContent.includes('FORMULIR PENDAFTARAN'));
  assert.ok(outContent.includes('Warno Suryanto'));
  assert.ok(outContent.includes('19 Juli 2026'));
});

test('DOCUMENTS THE DEFECT: the old single-blended-target construction still reports a false clean match', async () => {
  // core/text-walk.js/core/redact.js were NOT changed by this fix — the fix
  // is entirely in WHAT GEOMETRY js/v2/app.js hands them (per-run targets,
  // see the REGRESSION test above). This test proves that claim: replayed
  // with the OLD single-blended-target shape, the exact same input still
  // reproduces the exact same defect (matched:true/clean, original text
  // survives) it always did. It's a permanent tripwire — if anyone ever
  // wires app.js back to `replaceTargets: [line.pdf]`, this failure mode is
  // still live and waiting.
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, srcPage, bytes } = await buildDocFromFixture(PDFLib, FIXTURE);
  const { line } = await deriveLine(srcPage, PDFLib);

  const replaceTargets = [line.pdf]; // the OLD (buggy) construction
  addGantiPair(doc, page, replaceTargets, 'Alamat : Cibeber, ');

  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const result = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });

  const outPdfDoc = await PDFLib.PDFDocument.load(result.bytes);
  const outContent = readPageContents(outPdfDoc.getPages()[0], PDFLib);
  // Documents the defect verbatim: 'clean' was reported...
  assert.deepEqual(result.outcomes[0].surgery, { matched: true, reason: 'clean' });
  // ...yet the original text is still right there in the export. This is the
  // bug, pinned so nobody re-wires app.js back to the single-target shape
  // without this test screaming about it.
  assert.ok(outContent.includes('Pondok Sapi'), 'documents the pre-fix defect: original text survives despite a clean report');
});
