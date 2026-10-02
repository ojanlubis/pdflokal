/*
 * PDFLokal — core/text-run-geometry.js  (pdf.js text items -> positioned runs)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for the per-item arithmetic that turns pdf.js
 * getTextContent() items into Run[] (page-space px, top-left origin, plus the
 * raw content-stream frame under `pdf`). Two callers, one function:
 *   - js/v2/text-runs.js  (the editor: Edit Teks Asli)
 *   - js/docx/extract.js  (PDF -> Word)
 * It was a copy in the DOCX spike (and a third in tests/core/block-edit.test.mjs);
 * the arithmetic is subtle (width rides the baseline DIRECTION, not the matrix
 * scale; the box spans descender to ascent through the matrix so it is right at
 * every page rotation), so a second copy is a second place to get it wrong.
 *
 * Pure: pdfjs (for Util), the text content and the viewport are all passed in.
 * `extra(item, style)` lets a caller attach its own fields to a run (the DOCX
 * extractor adds `dir` and the resolved font style); it must not overwrite the
 * geometry fields.
 */

// A zero-length baseline vector (degenerate transform) must not divide by
// zero into NaN — fall back to the "along +x" direction, same convention
// text-walk.js uses for its own normalize().
function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len === 0 ? [1, 0] : [x / len, y / len];
}

export function runsFromTextContent({ pdfjs, tc, vp, extra }) {
  const runs = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const style = tc.styles[item.fontName] || {};
    const m = pdfjs.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(m[2], m[3]); // length of the em vector = font size on screen
    if (!fh || !item.width) continue;
    // item.width is USER-space (font size already baked in) — it must ride
    // the baseline DIRECTION of the matrix, never its scale, or every box
    // is fontSize× too wide. Height (the em vector) does come from the
    // matrix. Corners → axis-aligned bbox, valid at every page rotation.
    const dirLen = Math.hypot(m[0], m[1]) || 1;
    const adv = [(m[0] / dirLen) * item.width * vp.scale, (m[1] / dirLen) * item.width * vp.scale];
    // Corners span DESCENDER (-0.25em, where the g/j/y tails live — a cover
    // that stops at the baseline leaves tails peeking out under it) to ascent
    // (+1em), through the matrix so the box is right at every page rotation.
    const pDesc = pdfjs.Util.applyTransform([0, -0.25], m);
    const pTop = pdfjs.Util.applyTransform([0, 1], m);
    const corners = [
      pDesc,
      [pDesc[0] + adv[0], pDesc[1] + adv[1]],
      pTop,
      [pTop[0] + adv[0], pTop[1] + adv[1]],
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const pad = fh * 0.06;
    // pdf: the RAW (unprojected) user-space geometry — content-stream frame,
    // viewport- and rotation-INDEPENDENT. This is what core/redact.js needs
    // (it walks the content stream directly, never the display viewport);
    // `m` above is the viewport-projected matrix and must never feed it.
    const [ux, uy] = normalize(item.transform[0], item.transform[1]);
    // org: the run's BASELINE ORIGIN in display (page-space) px — the
    // transform applied to (0,0). Rung D (core/block-edit.js) places the
    // paragraph editor on the original first baseline from it, instead of
    // inverting the box arithmetic above from a second file.
    const org = pdfjs.Util.applyTransform([0, 0], m);
    const run = {
      str: item.str,
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: (Math.max(...xs) - Math.min(...xs)) + pad * 2,
      h: (Math.max(...ys) - Math.min(...ys)) + pad * 2,
      size: fh,
      fontName: item.fontName,
      fontFamily: style.fontFamily || '',
      org: { x: org[0], y: org[1] },
      pdf: {
        x0: item.transform[4], y0: item.transform[5],
        ux, uy,
        len: item.width,
        size: Math.hypot(item.transform[2], item.transform[3]),
      },
    };
    if (extra) Object.assign(run, extra(item, style));
    runs.push(run);
  }
  return runs;
}
