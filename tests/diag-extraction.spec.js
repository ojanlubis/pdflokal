/*
 * PDFLokal — tests/diag-extraction.spec.js  (DIAGNOSTIC PROBE — no fix)
 * ============================================================================
 * Founder field report (phone test, 2026-07-21): the per-line editor's
 * EXTRACTED text doesn't match what's visually on the page, on two fresh
 * fixtures:
 *
 *   lorem-testing.pdf     — tapping the big "TESTING" heading opens the
 *                            editor prefilled with "Lorem ipsumTESTINGdolo…":
 *                            the heading (its own, much larger, far-above
 *                            line) got merged with body-paragraph text.
 *   perpres-letterhead.pdf — tapping "PRESIDEN" in the letterhead extracts
 *                            "PRES IDEN": a space inferred INSIDE one
 *                            letter-spaced word.
 *
 * This spec does not fix anything. It dumps the pipeline's own numbers at
 * every stage — pdf.js raw items (js/v2/text-runs.js's extract(), exposed as
 * window.v2.textRuns.getRuns), the clustered Lines (getLines), and the
 * hitTest resolution — so the PM can see exactly where the divergence
 * originates: raw pdf.js items, our baseline/along CLUSTERING (core/
 * text-lines.js groupRunsIntoLines), or our SPACE-INFERENCE (assembleLine's
 * SPACE_GAP_FACTOR check).
 *
 * It DOES assert the two symptoms reproduce (so the repro is locked), but
 * asserts nothing about what the "correct" output should be — that's the
 * PM's call once the data is in hand.
 *
 * Run: SPIKE= npx playwright test tests/diag-extraction.spec.js --project=chromium --reporter=list
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// Mirrors core/text-lines.js's own constants — printed here (not imported;
// this spec runs in the Playwright/node context, the constants live in a
// browser ES module) so the dump can show the threshold next to the number
// it's judging, without touching production code.
const SPACE_GAP_FACTOR = 0.18;
const PERP_TOLERANCE_FACTOR = 0.35;
const DIRECTION_DOT_MIN = 0.996;
const COLUMN_GAP_FACTOR = 1.5;

async function openDoc(page, fixturePath) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixturePath);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

// Pull runs + lines for page 1 straight from the app's own live index —
// window.v2.textRuns is the exact object js/v2/app.js wires the editor's
// tap path through (see js/v2/app.js:361,729,805).
async function dumpPage1(page) {
  return page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const runs = await window.v2.textRuns.getRuns(pg.id);
    const lines = await window.v2.textRuns.getLines(pg.id);
    return {
      pageId: pg.id,
      runs: runs.map((r) => ({
        str: r.str,
        x: r.x, y: r.y, w: r.w, h: r.h, size: r.size,
        fontName: r.fontName, fontFamily: r.fontFamily,
        pdf: r.pdf,
      })),
      lines: lines.map((l) => ({
        str: l.str,
        x: l.x, y: l.y, w: l.w, h: l.h, size: l.size,
        fontName: l.fontName, fontFamily: l.fontFamily,
        pdf: l.pdf,
        runStrs: l.runs.map((r) => r.str),
      })),
    };
  });
}

async function hitTestAt(page, x, y) {
  return page.evaluate(async ({ x: px, y: py }) => {
    const pg = window.v2.getDoc().pages[0];
    const line = await window.v2.textRuns.hitTest(pg.id, px, py);
    return line ? { str: line.str, x: line.x, y: line.y, w: line.w, h: line.h, runStrs: line.runs.map((r) => r.str) } : null;
  }, { x, y });
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : String(n);
}

function printRun(r, i) {
  console.log(
    `  [run ${i}] str=${JSON.stringify(r.str)}\n`
    + `           display: x=${fmt(r.x)} y=${fmt(r.y)} w=${fmt(r.w)} h=${fmt(r.h)} size=${fmt(r.size)}\n`
    + `           font: fontName=${r.fontName} fontFamily=${JSON.stringify(r.fontFamily)}\n`
    + `           pdf-geom: x0=${fmt(r.pdf.x0)} y0=${fmt(r.pdf.y0)} ux=${fmt(r.pdf.ux)} uy=${fmt(r.pdf.uy)} len=${fmt(r.pdf.len)} size=${fmt(r.pdf.size)}`,
  );
}

function printLine(l, i) {
  console.log(
    `  [line ${i}] str=${JSON.stringify(l.str)}  (${l.runStrs.length} member run(s): ${JSON.stringify(l.runStrs)})\n`
    + `            display: x=${fmt(l.x)} y=${fmt(l.y)} w=${fmt(l.w)} h=${fmt(l.h)} size=${fmt(l.size)}\n`
    + `            font: fontName=${l.fontName} fontFamily=${JSON.stringify(l.fontFamily)}\n`
    + `            pdf-geom: x0=${fmt(l.pdf.x0)} y0=${fmt(l.pdf.y0)} ux=${fmt(l.pdf.ux)} uy=${fmt(l.pdf.uy)} len=${fmt(l.pdf.len)} size=${fmt(l.pdf.size)}`,
  );
}

// along()/perp() from core/text-lines.js, reimplemented on plain {x0,y0,ux,uy,len}
// objects for the dump's own gap arithmetic — same formulas, this file's
// copy only ever READS numbers, never feeds them back into the app.
function along(pdf) {
  const a0 = pdf.x0 * pdf.ux + pdf.y0 * pdf.uy;
  return { a0, a1: a0 + pdf.len };
}
function perp(pdf) {
  return -pdf.x0 * pdf.uy + pdf.y0 * pdf.ux;
}

test.describe('DIAGNOSTIC PROBE — extraction vs visual divergence (no fix, dump only)', () => {
  test('lorem-testing.pdf: heading "TESTING" merges with body paragraph', async ({ page }) => {
    await openDoc(page, NASTY('lorem-testing.pdf'));
    const dump = await dumpPage1(page);

    console.log('\n========== lorem-testing.pdf — PAGE 1 RAW RUNS (pdf.js items via extract()) ==========');
    console.log(`TOTAL RUNS: ${dump.runs.length}`);
    dump.runs.forEach(printRun);

    const testingRuns = dump.runs.filter((r) => r.str.includes('TESTING'));
    const loremRuns = dump.runs.filter((r) => /lorem/i.test(r.str));
    console.log(`\n"TESTING" appears in ${testingRuns.length} raw run(s): ${JSON.stringify(testingRuns.map((r) => r.str))}`);
    console.log(`"Lorem"/"lorem" appears in ${loremRuns.length} raw run(s): ${JSON.stringify(loremRuns.map((r) => r.str))}`);

    console.log('\n========== lorem-testing.pdf — CLUSTERED LINES (groupRunsIntoLines) ==========');
    console.log(`TOTAL LINES: ${dump.lines.length}`);
    dump.lines.forEach(printLine);

    // Perp offsets + sizes of the TESTING run vs the first Lorem-ipsum run,
    // and whether clusterBaselines' direction+band test would keep them
    // apart — the exact numbers the baseline pass judges.
    const headingRun = dump.runs.find((r) => r.str.includes('TESTING'));
    const bodyRun = dump.runs.find((r) => /lorem/i.test(r.str));
    console.log('\n========== lorem-testing.pdf — BASELINE-CLUSTERING NUMBERS ==========');
    if (headingRun && bodyRun) {
      const hP = perp(headingRun.pdf);
      const bP = perp(bodyRun.pdf);
      const dot = headingRun.pdf.ux * bodyRun.pdf.ux + headingRun.pdf.uy * bodyRun.pdf.uy;
      const tol = PERP_TOLERANCE_FACTOR * Math.max(headingRun.pdf.size, bodyRun.pdf.size);
      console.log(`heading "TESTING" run: pdf.size=${fmt(headingRun.pdf.size)} display.size=${fmt(headingRun.size)} perp(p)=${fmt(hP)} display.y=${fmt(headingRun.y)}`);
      console.log(`body "Lorem..." run:   pdf.size=${fmt(bodyRun.pdf.size)} display.size=${fmt(bodyRun.size)} perp(p)=${fmt(bP)} display.y=${fmt(bodyRun.y)}`);
      console.log(`|Δp| = ${fmt(Math.abs(hP - bP))}   PERP_TOLERANCE_FACTOR(${PERP_TOLERANCE_FACTOR}) * max(size) = ${fmt(tol)}   within tolerance? ${Math.abs(hP - bP) <= tol}`);
      console.log(`direction dot product = ${fmt(dot)}   DIRECTION_DOT_MIN = ${DIRECTION_DOT_MIN}   direction agrees? ${dot >= DIRECTION_DOT_MIN}`);
    } else {
      console.log(`could not isolate a single heading/body run pair — headingRun=${!!headingRun} bodyRun=${!!bodyRun}`);
    }

    // Full ordered dump of every run's perp offset, to see the actual chain
    // from heading down through the body paragraph (chaining via running
    // mean is the clustering's own documented risk).
    console.log('\nAll runs sorted by perp offset p (ascending) — this is clusterBaselines\' own iteration order:');
    const byP = dump.runs.map((r) => ({ str: r.str, p: perp(r.pdf), size: r.pdf.size, ux: r.pdf.ux, uy: r.pdf.uy }))
      .sort((a, b) => a.p - b.p);
    byP.forEach((r, i) => console.log(`  [${i}] p=${fmt(r.p)} size=${fmt(r.size)} dir=(${fmt(r.ux)},${fmt(r.uy)}) str=${JSON.stringify(r.str)}`));

    // Where does a tap at the heading's visual center resolve to?
    const headingDisplay = dump.runs.find((r) => r.str.includes('TESTING'));
    const tapX = headingDisplay.x + headingDisplay.w / 2;
    const tapY = headingDisplay.y + headingDisplay.h / 2;
    const resolved = await hitTestAt(page, tapX, tapY);
    console.log(`\n========== lorem-testing.pdf — hitTest at heading center (${fmt(tapX)}, ${fmt(tapY)}) ==========`);
    console.log(`resolved line str = ${JSON.stringify(resolved && resolved.str)}`);
    console.log(`resolved line member runs = ${JSON.stringify(resolved && resolved.runStrs)}`);

    // LOCK THE REPRO — this is what the founder saw on the phone.
    expect(resolved, 'tap at the TESTING heading must resolve to SOME line').not.toBeNull();
    expect(resolved.str).toContain('TESTING');
    expect(resolved.str).toMatch(/lorem/i);
  });

  test('perpres-letterhead.pdf: "PRESIDEN" extracts as "PRES IDEN"', async ({ page }) => {
    await openDoc(page, NASTY('perpres-letterhead.pdf'));
    const dump = await dumpPage1(page);

    console.log('\n========== perpres-letterhead.pdf — PAGE 1 RAW RUNS (pdf.js items via extract()) ==========');
    console.log(`TOTAL RUNS: ${dump.runs.length}`);
    dump.runs.forEach(printRun);

    const presidenRuns = dump.runs.filter((r) => /PRES|IDEN/i.test(r.str));
    console.log(`\nRuns matching /PRES|IDEN/i: ${presidenRuns.length} — ${JSON.stringify(presidenRuns.map((r) => r.str))}`);
    console.log(`Is "PRESIDEN" one run or many? ${dump.runs.some((r) => r.str.trim() === 'PRESIDEN') ? 'ONE run, full word' : (presidenRuns.length > 1 ? `MANY runs (${presidenRuns.length})` : 'not found as expected')}`);

    console.log('\n========== perpres-letterhead.pdf — CLUSTERED LINES (groupRunsIntoLines) ==========');
    console.log(`TOTAL LINES: ${dump.lines.length}`);
    dump.lines.forEach(printLine);

    const letterheadLine = dump.lines.find((l) => /PRES\s*IDEN/i.test(l.str));
    console.log('\n========== perpres-letterhead.pdf — letterhead line ==========');
    console.log(`letterhead line str = ${JSON.stringify(letterheadLine && letterheadLine.str)}`);

    // Along-gap between consecutive glyphs/runs that make up "PRESIDEN",
    // vs the SPACE_GAP_FACTOR threshold — the exact arithmetic
    // assembleLine's space-inference runs.
    console.log('\n========== perpres-letterhead.pdf — SPACE-INFERENCE NUMBERS (within PRESIDEN) ==========');
    console.log(`SPACE_GAP_FACTOR = ${SPACE_GAP_FACTOR}  (threshold = SPACE_GAP_FACTOR * PRECEDING run's pdf.size)`);
    // Find every raw run whose str is a substring of "PRESIDEN" (letter-
    // spaced words are commonly one glyph/run each) OR the run(s) that
    // together spell it, in paint order, then walk consecutive gaps.
    const presChain = dump.runs.filter((r) => 'PRESIDEN'.includes(r.str.trim()) && r.str.trim().length > 0);
    if (presChain.length > 1) {
      const withAlong = presChain.map((r) => ({ str: r.str, ...along(r.pdf), size: r.pdf.size }));
      withAlong.sort((a, b) => a.a0 - b.a0);
      for (let i = 1; i < withAlong.length; i += 1) {
        const prev = withAlong[i - 1];
        const cur = withAlong[i];
        const gap = cur.a0 - prev.a1;
        const threshold = SPACE_GAP_FACTOR * prev.size;
        console.log(`  ${JSON.stringify(prev.str)} -> ${JSON.stringify(cur.str)}: gap=${fmt(gap)} threshold=${fmt(threshold)} INFER SPACE? ${gap > threshold}`);
      }
    } else {
      console.log(`  "PRESIDEN" did not decompose into >1 raw run by simple substring match (found ${presChain.length}) — printing ALL runs' along-extents in the letterhead line instead:`);
      if (letterheadLine) {
        const memberRuns = letterheadLine.runs.map((r) => ({ str: r.str, ...along(r.pdf), size: r.pdf.size }));
        memberRuns.sort((a, b) => a.a0 - b.a0);
        for (let i = 0; i < memberRuns.length; i += 1) {
          const cur = memberRuns[i];
          if (i === 0) {
            console.log(`  [0] str=${JSON.stringify(cur.str)} a0=${fmt(cur.a0)} a1=${fmt(cur.a1)} size=${fmt(cur.size)}`);
            continue;
          }
          const prev = memberRuns[i - 1];
          const gap = cur.a0 - prev.a1;
          const threshold = SPACE_GAP_FACTOR * prev.size;
          console.log(`  [${i}] ${JSON.stringify(prev.str)} -> ${JSON.stringify(cur.str)}: gap=${fmt(gap)} threshold=${fmt(threshold)} INFER SPACE? ${gap > threshold}`);
        }
      }
    }

    // Where does a tap at "PRESIDEN"'s visual center resolve to?
    // Prefer a raw run whose str contains PRESIDEN or is part of it; fall
    // back to the clustered line's own box if pdf.js already split it into
    // single letters (no single run would contain the full word then).
    const presRunWhole = dump.runs.find((r) => r.str.trim() === 'PRESIDEN');
    const target = presRunWhole || letterheadLine;
    const tapX = target.x + target.w / 2;
    const tapY = target.y + target.h / 2;
    const resolved = await hitTestAt(page, tapX, tapY);
    console.log(`\n========== perpres-letterhead.pdf — hitTest at PRESIDEN center (${fmt(tapX)}, ${fmt(tapY)}) ==========`);
    console.log(`resolved line str = ${JSON.stringify(resolved && resolved.str)}`);
    console.log(`resolved line member runs = ${JSON.stringify(resolved && resolved.runStrs)}`);

    // LOCK THE REPRO — the founder's phone-test symptom: a space inside the
    // single word PRESIDEN.
    expect(resolved, 'tap at PRESIDEN must resolve to SOME line').not.toBeNull();
    expect(resolved.str).toMatch(/PRES\s+IDEN|P\s*R\s*E\s*S\s*I\s*D\s*E\s*N/i);
  });
});
