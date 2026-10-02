/*
 * PDFLokal — docx/color.js  (COLOUR: text colour, fills, backgrounds, vector shapes)   [STUB: lane owns this file]
 * ============================================================================
 * THE INTERFACE (decided by the foundation; a lane implements the body, not the shape)
 *
 *   analyzeColor(ctx) -> ColorInfo        (async or sync; convert awaits it)
 *
 *     Called once per page, after extract.readPage / images / OCR (so ctx.runs is final)
 *     and BEFORE extract.groupLines, tables and layout. pdf.js gives NO colour on a text
 *     item and no operator index: getTextContent() items carry only str/transform/font.
 *     The colour lane therefore walks `ctx.ops` (page.getOperatorList()) with
 *     ops.walkOps (which tracks the CTM; graphics-state colour is yours to track) and
 *     matches paint events to `ctx.runs` BY GEOMETRY (run.pdf.x0/y0 in content-stream
 *     space, run.x/y/w/h in page space).
 *
 *     It MUST do three things:
 *       1. Set `run.color = 'RRGGBB' | null` on the runs it can resolve (null = leave
 *          the colour to Word's default). extract.styledRuns copies it to Run.c and
 *          only merges neighbouring runs of equal colour.
 *       2. Return `fillAt(x0, y0, x1, y1) -> 'RRGGBB' | null`: the solid fill painted
 *          behind that page rectangle (tables use it for cell shading). null = none/white page.
 *       3. Return `anchors: Anchor[]` (see model.js; kind 'shape' is registered below):
 *          page backgrounds and vector rectangles drawn BEHIND the text, each with `z` = its
 *          operator index so convert.js can interleave them with images in paint order.
 *
 *     ColorInfo = { fillAt, anchors, background: 'RRGGBB'|null, stats?: {} }
 *
 *   The 'shape' anchor writer below is registered with writer.js at import: a minimal
 *   DrawingML rectangle (wps) anchored to the page behind the text. Extend it (strokes,
 *   rounded rects, paths) here; writer.js is not touched.
 */

import { registerAnchor } from './writer.js';

// eslint-disable-next-line no-unused-vars
export function analyzeColor(ctx) {
  return { fillAt: () => null, anchors: [], background: null }; // STUB: spike drops all colour
}

// A filled rectangle anchored to the page, behind the text.
// relativeHeight: see the KNOWN GAP note in writer.js imgXml (small values stack erratically in LibreOffice).
function shapeXml(s, w) {
  w.useNamespace('wps', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape');
  const id = w.nextId();
  const fill = s.fill && /^[0-9a-f]{6}$/i.test(s.fill) ? `<a:solidFill><a:srgbClr val="${s.fill}"/></a:solidFill>` : '<a:noFill/>';
  const line = s.stroke && /^[0-9a-f]{6}$/i.test(s.stroke.c)
    ? `<a:ln w="${Math.max(1, Math.round((s.stroke.wPt || 0.5) * 12700))}"><a:solidFill><a:srgbClr val="${s.stroke.c}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const cx = w.emu(s.wPt);
  const cy = w.emu(s.hPt);
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
    + '<wp:simplePos x="0" y="0"/>'
    + `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(s.x * 12700)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(s.y * 12700)}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="Shape ${id}"/><wp:cNvGraphicFramePr/>`
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/>'
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${line}</wps:spPr>`
    + '<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

registerAnchor('shape', shapeXml);
