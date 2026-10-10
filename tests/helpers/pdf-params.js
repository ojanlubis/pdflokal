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
//           A negative w or h writes the corners swapped ([0,792,612,-792] is
//           the file's [0 792 612 0]); the spec allows any corner order and
//           readers take min/max.
// cropBox   null = none; else [x, y, w, h], may poke outside the MediaBox
//           (the reader shows the intersection). 'inverted' = the inset crop
//           with its corners written top-down.
// rotate    /Rotate, multiples of 90.
// inherit   true: /Rotate sits on the Pages node and the page inherits it.
// userUnit  /UserUnit (PDF 1.6): a unit larger than 1/72 inch.
export const GEOMETRY_AXES = {
  mediaBox: [[0, 0, 612, 792], [0, 200, 612, 592], [-50, -150, 595, 842], [0, 792, 612, -792]],
  cropBox: [null, 'inset', 'overhang', 'inverted'],
  rotate: [0, 90, 180, 270],
  inherit: [false, true],
  userUnit: [1, 2],
};

// The same rectangle with a positive width and height, whatever corner order
// the axis value was written in.
export function normalizedRect([x, y, w, h]) {
  return [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)];
}

// A crop described relative to the MediaBox, so it stays meaningful whatever
// the MediaBox axis picked.
export function cropFor(kind, box) {
  const [x, y, w, h] = normalizedRect(box);
  if (kind === 'inverted') return [x + 40, y + 60 + (h - 160), w - 120, -(h - 160)]; // inset, top edge first
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
    const p = d.addPage([Math.abs(w), Math.abs(h)]);
    p.setMediaBox(x, y, w, h);
    if (crop) p.setCropBox(...crop);
    // The frame follows the box the reader shows, not the written corners.
    const [fx, fy, fw, fh] = [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)];
    p.drawRectangle({ x: fx + 4, y: fy + 4, width: fw - 8, height: fh - 8, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 2 });
    if (c.rotate) {
      if (c.inherit) d.catalog.Pages().set(PDFName.of('Rotate'), PDFNumber.of(c.rotate));
      else p.node.set(PDFName.of('Rotate'), PDFNumber.of(c.rotate));
    }
    if (c.userUnit !== 1) p.node.set(PDFName.of('UserUnit'), PDFNumber.of(c.userUnit));
    return Array.from(await d.save());
  }, { c, crop }));
}

// ---- Slice 2: printed text, the subject of Edit (Ganti/Hapus) --------------
// font        the three built-in (non-embedded, WinAnsi) faces, and an
//             embedded TrueType (pdf-lib writes it as Type0 / Identity-H;
//             tests/fixtures/carlito-latin.ttf, Carlito OFL cut to Latin-1 with
//             pyftsubset, since pdf-lib cannot subset a woff2).
// size        font size in points.
// squeeze     Tz, horizontal scaling in percent.
// charSpacing Tc, extra space after every glyph.
// mediaBox    the slice-1 axis that broke the field report, crossed with text.
export const TEXT_AXES = {
  font: ['Helvetica', 'TimesRoman', 'Courier', 'ttf'],
  size: [9, 14, 28],
  squeeze: [100, 130],
  charSpacing: [0, 1.5],
  mediaBox: [[0, 0, 612, 792], [0, 200, 612, 592]],
};
export const TEXT_SUBJECT = 'Halo Budi Santoso';
export const TEXT_BYSTANDER = 'Nomor 12345';

export function textCaseName(c) {
  return `font:${c.font} ${c.size}pt Tz:${c.squeeze} Tc:${c.charSpacing} media[${c.mediaBox.join(',')}]`;
}

/**
 * One page with TEXT_SUBJECT at 30% from the top and TEXT_BYSTANDER at 60%,
 * both drawn with raw text operators so Tz/Tc are really in the stream.
 */
export async function buildTextPdf(page, c) {
  for (const [glob, url] of [['PDFLib', '/js/vendor/pdf-lib.min.js'], ['fontkit', '/js/vendor/fontkit.umd.min.js']]) {
    if (!(await page.evaluate((g) => Boolean(window[g]), glob))) await page.addScriptTag({ url });
  }
  return Buffer.from(await page.evaluate(async ({ c, subject, bystander }) => {
    const L = window.PDFLib;
    const d = await L.PDFDocument.create();
    d.registerFontkit(window.fontkit);
    const font = c.font === 'ttf'
      ? await d.embedFont(new Uint8Array(await (await fetch('/tests/fixtures/carlito-latin.ttf')).arrayBuffer()), { subset: true })
      : await d.embedFont(L.StandardFonts[c.font]);
    const [x, y, w, h] = c.mediaBox;
    const p = d.addPage([w, h]);
    p.setMediaBox(x, y, w, h);
    const key = p.node.newFontDictionary(font.name, font.ref);
    const line = (str, top) => [
      L.beginText(),
      L.setFontAndSize(key, c.size),
      L.setCharacterSqueeze(c.squeeze),
      L.setCharacterSpacing(c.charSpacing),
      L.moveText(x + 72, y + h * (1 - top)),
      L.showText(font.encodeText(str)),
      L.endText(),
    ];
    p.pushOperators(...line(subject, 0.3), ...line(bystander, 0.6));
    return Array.from(await d.save());
  }, { c, subject: TEXT_SUBJECT, bystander: TEXT_BYSTANDER }));
}
