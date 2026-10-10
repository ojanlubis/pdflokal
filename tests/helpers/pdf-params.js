/*
 * PDFLokal — PDF fixtures generated from the FORMAT's parameters.
 *
 * WHY (his ruling 2026-10-10, seat decisions.md): we used to collect PDFs from
 * the wild and hope they covered what generators do. The format itself is
 * finite: attack its parameters, not the outputs. A field report that day
 * (the download moved everything down) was one parameter, a MediaBox origin
 * above 0, carried by no file in the corpus. The wild corpus stays as the
 * second witness, because real files break the spec.
 *
 * Each AXIS is one thing the spec lets a page vary. `pairwise(AXES)` picks a
 * small set of cases in which every pair of values from two different axes
 * appears at least once (full combinations explode; pairs are where most
 * interaction bugs live). Add an axis by adding a key: every spec that walks
 * the cases picks it up.
 *
 * Slice 1 is page geometry. Next slices (seat TODO): text, source
 * annotations/AcroForm, resources/XObjects, encryption, file structure.
 */

// SINGLE SOURCE OF TRUTH for the page-geometry axes.
// mediaBox  [x, y, w, h]. The origin is NOT always 0,0 (scanners, imposition).
// cropBox   null = none; else [x, y, w, h], may poke outside the MediaBox
//           (the reader shows the intersection).
// rotate    /Rotate, multiples of 90.
// inherit   true: /Rotate sits on the Pages node and the page inherits it.
// userUnit  /UserUnit (PDF 1.6): a unit larger than 1/72 inch.
export const GEOMETRY_AXES = {
  mediaBox: [[0, 0, 612, 792], [0, 200, 612, 592], [-50, -150, 595, 842]],
  cropBox: [null, 'inset', 'overhang'],
  rotate: [0, 90, 180, 270],
  inherit: [false, true],
  userUnit: [1, 2],
};

// A crop described relative to the MediaBox, so it stays meaningful whatever
// the MediaBox axis picked.
export function cropFor(kind, [x, y, w, h]) {
  if (kind === 'inset') return [x + 40, y + 60, w - 120, h - 160];
  if (kind === 'overhang') return [x + 30, y - 40, w, h - 100]; // pokes below and right
  return null;
}

// Greedy pairwise cover, deterministic: same axes → same cases, so a red case
// keeps its name between runs.
export function pairwise(axes) {
  const keys = Object.keys(axes);
  const all = keys.reduce((acc, k) => acc.flatMap((c) => axes[k].map((v, i) => ({ ...c, [k]: i }))), [{}]);
  const pairsOf = (c) => {
    const out = [];
    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) out.push(`${keys[a]}=${c[keys[a]]}|${keys[b]}=${c[keys[b]]}`);
    }
    return out;
  };
  const uncovered = new Set(all.flatMap(pairsOf));
  const picked = [];
  while (uncovered.size) {
    let best = null; let bestGain = -1;
    for (const c of all) {
      const gain = pairsOf(c).filter((p) => uncovered.has(p)).length;
      if (gain > bestGain) { best = c; bestGain = gain; }
    }
    for (const p of pairsOf(best)) uncovered.delete(p);
    picked.push(best);
  }
  return picked.map((c) => Object.fromEntries(keys.map((k) => [k, axes[k][c[k]]])));
}

export function caseName(c) {
  return `media[${c.mediaBox.join(',')}] crop:${c.cropBox ?? 'none'} rot:${c.rotate}${c.inherit ? '(inherited)' : ''} uu:${c.userUnit}`;
}

/**
 * Build a one-page PDF for case `c` inside the page, with the product's own
 * pdf-lib (/js/vendor/pdf-lib.min.js). Returns a Buffer. The page carries a
 * thin frame along its MediaBox so a viewer has ink to show.
 */
export async function buildGeometryPdf(page, c) {
  if (!(await page.evaluate(() => Boolean(window.PDFLib)))) {
    await page.addScriptTag({ url: '/js/vendor/pdf-lib.min.js' });
  }
  const crop = c.cropBox ? cropFor(c.cropBox, c.mediaBox) : null;
  return Buffer.from(await page.evaluate(async ({ c, crop }) => {
    const { PDFDocument, PDFName, PDFNumber, rgb } = window.PDFLib;
    const d = await PDFDocument.create();
    const [x, y, w, h] = c.mediaBox;
    const p = d.addPage([w, h]);
    p.setMediaBox(x, y, w, h);
    if (crop) p.setCropBox(...crop);
    p.drawRectangle({ x: x + 4, y: y + 4, width: w - 8, height: h - 8, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 2 });
    if (c.rotate) {
      if (c.inherit) d.catalog.Pages().set(PDFName.of('Rotate'), PDFNumber.of(c.rotate));
      else p.node.set(PDFName.of('Rotate'), PDFNumber.of(c.rotate));
    }
    if (c.userUnit !== 1) p.node.set(PDFName.of('UserUnit'), PDFNumber.of(c.userUnit));
    return Array.from(await d.save());
  }, { c, crop }));
}
