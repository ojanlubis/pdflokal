/*
 * A one-page PDF whose ONLY font is a true subset (tests/fixtures/nasty/
 * carlito-subset.ttf: é present, É absent) wearing a name that routes to NO
 * metric clone — /BaseFont and /FontName rewritten to 'Zeta-Regular'.
 *
 * WHY: every clone pdflokal ships is metric-identical to the font it stands
 * in for (that is what a clone is), so on nota-subset.pdf a per-glyph mix of
 * the doc subset and the Carlito clone paints the SAME width as the clone
 * alone — a width test there cannot tell one font from two. Here the line's
 * only bundled face is the Arimo substitute, whose metrics differ from
 * Carlito's, so "the whole line in one face" and "doc font + a fallback glyph"
 * paint measurably different widths. Built at test time from repo assets so
 * no new binary fixture is committed.
 *
 * Built INSIDE the page with the app's own vendored pdf-lib (the test server
 * serves the repo root, fixtures included), then handed back as a Buffer for
 * setInputFiles. Line: 'Kafé Andréa, Jakarta Selatan' at x=72 y=720 size=12.
 */
import { Buffer } from 'node:buffer';

export async function unroutedSubsetPdf(page) {
  const bytes = await page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const ttf = await (await fetch('/tests/fixtures/nasty/carlito-subset.ttf')).arrayBuffer();
    const doc = await PDFLib.PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(ttf, { subset: false });
    doc.addPage([595, 842]).drawText('Kafé Andréa, Jakarta Selatan', { x: 72, y: 720, size: 12, font });
    const re = await PDFLib.PDFDocument.load(await doc.save());
    // Rename every name a font router could read: the Type0 wrapper, its
    // descendant, and the descriptor.
    const { PDFName, PDFDict } = PDFLib;
    const name = PDFName.of('Zeta-Regular');
    for (const [, obj] of re.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (obj.get(PDFName.of('BaseFont'))) obj.set(PDFName.of('BaseFont'), name);
      if (obj.get(PDFName.of('FontName'))) obj.set(PDFName.of('FontName'), name);
    }
    return Array.from(await re.save());
  });
  return Buffer.from(bytes);
}
