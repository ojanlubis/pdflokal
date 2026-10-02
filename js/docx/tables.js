/*
 * PDFLokal — docx/tables.js  (TABLES: detection + the 'tbl' block writer)   [STUB: lane owns this file]
 * ============================================================================
 * THE INTERFACE (decided by the foundation; a lane implements the body, not the shape)
 *
 *   detectTables(ctx) -> TableClaim[]
 *
 *     Called once per page, AFTER extract.groupLines (ctx.lines, ctx.words exist) and
 *     after color.analyzeColor (ctx.color.fillAt(...) tells a cell's background, so a
 *     table can carry its colour), BEFORE layout. Return the tables found:
 *
 *       TableClaim = {
 *         x0, y0, x1, y1,         page pt, top-left origin: the table's bounding box
 *         lines: Line[],          the ctx.lines objects the table CONSUMES. layout.js
 *                                 drops exactly these from the text flow (by identity),
 *                                 so nothing is printed twice. Lines you do not list
 *                                 stay body text, in reading order.
 *         block: Table,           the model block (see model.js): colsPt, rows of
 *                                 Cell { blocks: Para[], span?, fill? }, border?
 *       }
 *
 *     layout.js places `block` in reading order by its box (it takes part in the XY cut
 *     like a very wide line) and fills its spaceBefore. A page with no tables returns [].
 *
 *   Building cell paragraphs: use extract.styledRuns(line, ctx) for runs, and
 *   layout.paragraphsOfLines(lines, ctx, bounds) to merge wrapped lines inside a cell
 *   (do not write a second paragraph merger).
 *
 *   The 'tbl' writer below is registered with writer.js at import. Cell shading
 *   (Cell.fill) is already written; extend tableXml for borders, merges, vAlign.
 */

import { registerBlock } from './writer.js';

// eslint-disable-next-line no-unused-vars
export function detectTables(ctx) {
  return []; // STUB: the spike made 0 Word tables (pdf2docx made 5,059 on the same corpus)
}

export function tableXml(t, w) {
  const border = t.border
    ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders>'
    : '';
  // A table has no space-before of its own: a spacer paragraph of exactly that height stands in.
  let x = t.spaceBefore > 0 ? w.paraXml({ kind: 'p', runs: [], lineExact: Math.max(1, t.spaceBefore) }) : '';
  x += `<w:tbl><w:tblPr><w:tblW w:w="${w.twip(t.colsPt.reduce((a, b) => a + b, 0))}" w:type="dxa"/>${border}<w:tblLayout w:type="fixed"/>`
    + '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr>';
  x += `<w:tblGrid>${t.colsPt.map((c) => `<w:gridCol w:w="${w.twip(c)}"/>`).join('')}</w:tblGrid>`;
  for (const row of t.rows) {
    x += '<w:tr>';
    row.forEach((cell, k) => {
      const paras = cell.blocks && cell.blocks.length ? cell.blocks : [{ kind: 'p', runs: [] }];
      const shd = cell.fill && /^[0-9a-f]{6}$/i.test(cell.fill) ? `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill}"/>` : '';
      x += `<w:tc><w:tcPr><w:tcW w:w="${w.twip(t.colsPt[k] || 0)}" w:type="dxa"/>${cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : ''}${shd}</w:tcPr>${paras.map((p) => w.paraXml(p)).join('')}</w:tc>`;
    });
    x += '</w:tr>';
  }
  return `${x}</w:tbl>`;
}

registerBlock('tbl', tableXml);
