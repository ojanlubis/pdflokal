/*
 * PDFLokal — docx/stack.js  (how the page's absolute pieces stack in Word and LibreOffice)
 * ============================================================================
 * Anchors (pictures from images.js, shapes from color.js) ride behind the text, in paint order. Three things the
 * consumers do that the PDF did not, each MEASURED 2026-10-02 in LibreOffice 26.2 and Apple Pages 14.4 (Word: INFERRED,
 * not run). They are integration problems: no lane owns them, they appear only when the lanes are put together.
 *
 *   1. A behind-text PICTURE is drawn above every behind-text SHAPE whatever relativeHeight says (blue picture, grey
 *      rectangle drawn after it: the rectangle vanishes). A picture a LATER shape overlaps is therefore written as a
 *      picture-filled shape (Img.asShape, writer.js), and shapes stack among themselves exactly as the numbers say.
 *   2. A table cell's SHADING is part of the text layer, so it is drawn over every behind-text anchor. A logo, a
 *      checkbox or an icon the PDF drew ON a shaded cell (the BPJS and Disdukcapil logos on the yellow header of n018)
 *      disappeared under the cell. Such an anchor is written IN FRONT of the text (Anchor.inFront, behindDoc="0"),
 *      but only where that cannot hide text: a stroke-only shape never can; a picture or a filled shape only when no
 *      line of text lies under it.
 *
 *   stackAnchors([shapes, pictures], { claims, lines }) -> Anchor[] in paint order, with asShape / inFront set
 */

// Anchors from different modules interleave by paint order (z = operator index).
export function stackAnchors(lists, over) {
  const all = lists.flat().map((a, k) => ({ a, k }));
  all.sort((x, y) => (x.a.z ?? Number.MAX_SAFE_INTEGER) - (y.a.z ?? Number.MAX_SAFE_INTEGER) || x.k - y.k);
  const out = all.map((e) => e.a);
  markPicturesUnderShapes(out);
  if (over && over.claims && over.claims.length) markOverCellFills(out, over.claims, over.lines || []);
  return out;
}

// page-pt box of an anchor ({x0,y0,x1,y1}) or null
const boxOf = (a) => {
  if (a.kind === 'img' && a.anchor) return { x0: a.anchor.x, y0: a.anchor.y, x1: a.anchor.x + a.wPt, y1: a.anchor.y + a.hPt };
  if (typeof a.x === 'number' && a.wPt > 0 && a.hPt > 0) return { x0: a.x, y0: a.y, x1: a.x + a.wPt, y1: a.y + a.hPt };
  return null;
};
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const areaOf = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);

// 1. A behind-text picture that a LATER shape overlaps is written as a shape: any overlap larger than a hairline.
function markPicturesUnderShapes(list) {
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.kind !== 'img' || !a.anchor || a.asShape) continue;
    const ax1 = a.anchor.x + a.wPt; const ay1 = a.anchor.y + a.hPt;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.kind === 'img' || !(b.wPt > 0 && b.hPt > 0) || typeof b.x !== 'number') continue;
      if (Math.min(ax1, b.x + b.wPt) - Math.max(a.anchor.x, b.x) > 0.2 && Math.min(ay1, b.y + b.hPt) - Math.max(a.anchor.y, b.y) > 0.2) { a.asShape = true; break; }
    }
  }
}

// The page-pt rectangles of the shaded cells of a table claim (block.rows x colsPt x rowsH, from the claim's top left).
// A vertically merged cell runs down through the 'continue' cells under it.
const cellAtSlot = (row, slot) => { let at = 0; for (const c of row) { if (at === slot) return c; at += c.span > 1 ? c.span : 1; } return null; };
export function filledCells(claim) {
  const b = claim && claim.block;
  if (!b || b.kind !== 'tbl' || !Array.isArray(b.rowsH) || !Array.isArray(b.colsPt)) return [];
  const colX = [claim.x0 + (b.indentLeft || 0)];
  for (const w of b.colsPt) colX.push(colX[colX.length - 1] + w);
  const rowY = [claim.y0];
  for (const h of b.rowsH) rowY.push(rowY[rowY.length - 1] + h);
  const out = [];
  b.rows.forEach((row, ri) => {
    let slot = 0;
    for (const c of row) {
      const span = c.span > 1 ? c.span : 1;
      if (c.fill && c.vmerge !== 'continue') {
        let r1 = ri + 1;
        if (c.vmerge === 'restart') while (r1 < b.rows.length && (cellAtSlot(b.rows[r1], slot) || {}).vmerge === 'continue') r1 += 1;
        out.push({ x0: colX[slot], x1: colX[Math.min(slot + span, colX.length - 1)], y0: rowY[ri], y1: rowY[Math.min(r1, rowY.length - 1)] });
      }
      slot += span;
    }
  });
  return out;
}

// 2. An anchor that sits mostly on shaded table cells goes in front of the text, unless that would hide text.
function markOverCellFills(list, claims, lines) {
  const cells = claims.flatMap(filledCells);
  if (!cells.length) return;
  const boxes = lines.concat(...claims.map((c) => c.lines || [])).map((l) => ({ x0: l.x, y0: l.y, x1: l.x + l.w, y1: l.y + l.h })).filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  for (const a of list) {
    const box = boxOf(a);
    if (!box || !(areaOf(box) > 0)) continue;
    let on = 0;
    for (const c of cells) on += overlapArea(box, c);
    if (on < 0.5 * areaOf(box)) continue;
    const strokeOnly = a.kind === 'shape' && !a.fill && !a.grad;
    if (!strokeOnly && boxes.some((t) => overlapArea(box, t) > 0.2 * areaOf(t))) continue; // it would cover words
    a.inFront = true;
  }
}

// The grid lines of a table claim (page pt): where its borders are drawn.
export function gridOf(claim) {
  const b = claim && claim.block;
  if (!b || b.kind !== 'tbl' || !Array.isArray(b.rowsH) || !Array.isArray(b.colsPt)) return null;
  const xs = [claim.x0 + (b.indentLeft || 0)];
  for (const w of b.colsPt) xs.push(xs[xs.length - 1] + w);
  const ys = [claim.y0];
  for (const h of b.rowsH) ys.push(ys[ys.length - 1] + h);
  return { xs, ys };
}

// Is a stroke-only box (both sides longer than a rule) the outline of a cell or block of cells of this claim? A box that is
// not (the row of single-character boxes of a form, a checkbox) is NOT drawn by the table and must stay a shape.
export function boxIsCellOutline(claim, box, tol = 3) {
  const g = gridOf(claim);
  if (!g) return true; // cannot tell: the old behaviour (the table draws it)
  const near = (arr, v) => arr.some((a) => Math.abs(a - v) <= tol);
  return near(g.xs, box[0]) && near(g.xs, box[2]) && near(g.ys, box[1]) && near(g.ys, box[3]);
}

// Is a rule (a line or a thin rectangle) lying on one of this claim's grid lines, i.e. is it a border the table draws?
export function ruleIsBorder(claim, box, tol = 3) {
  const g = gridOf(claim);
  if (!g) return true;
  const w = box[2] - box[0]; const h = box[3] - box[1];
  const near = (arr, v) => arr.some((a) => Math.abs(a - v) <= tol);
  return w <= h ? near(g.xs, (box[0] + box[2]) / 2) : near(g.ys, (box[1] + box[3]) / 2);
}
