/*
 * PDFLokal — core/export.js  (I/O ADAPTER at the browser edge — PDF OUT)
 * ============================================================================
 * Turns a core Doc back into PDF bytes with pdf-lib. Mirror of import.js: this
 * is the ONE place pdf-lib touches the model on the way out. The pure core
 * (model.js/operations.js) never imports a vendor lib — pdf-lib and fontkit
 * are INJECTED via `deps` (defaulting to the browser globals), so this module
 * has zero vendor imports and no ueState/DOM dependencies.
 *
 * COORDINATES — the one contract everything below hangs on:
 *   Core annotations live in PAGE-SPACE POINTS with a TOP-LEFT origin, in the
 *   rotated page frame the user sees (see render/page-view.js). PDF space is
 *   BOTTOM-LEFT origin in the UNROTATED frame — pdf-lib's setRotation() is
 *   metadata only: drawing happens in unrotated page space and the viewer
 *   rotates on display. So every annotation goes through
 *   transformAnnotationCoords() to (a) flip Y and (b) undo the page rotation.
 *   For rotation 0 that reduces to y_pdf = pageHeight - y_top - elementHeight.
 *
 *   There is NO canvas/pixel scale here. The old editor's pageScales ×
 *   devicePixelRatio dance does not exist in the core — annotations are
 *   already in points. Do not reintroduce scale math.
 */

import { buildExportPlan } from './operations.js';
import { applyPageSurgery } from './page-surgery.js';
import { resolveDecidedFont, blockText } from './stamp.js';
import { placeBlockLines } from './block-edit.js';
import { CLONE_FONT_VARIANTS, CLONE_FONT_URLS, isSfntFontProgram } from './clone-fonts.js';
import { toStandardFontSafe, drawTextSafe, unencodableInStandardFont } from './text-encode.js';
import { totalPageRotation } from './page-rotation.js';
import { orderedForPaint } from './annotation-order.js';
import { scaleAnnotationGeometry, extentOf, displayedBox, turnOf, turnVector } from './annotation-geometry.js';
import { sniffImageFormat } from './image-format.js';

// ---- fonts ------------------------------------------------------------------

// Key format: [family] → { [bold][italic] } → pdf-lib font name.
// Helvetica/Times/Courier are pdf-lib standard fonts (no bytes embedded);
// Montserrat is a self-hosted file embedded via fontkit. The five
// Croscore/crosextra clone families (Arimo/Tinos/Cousine/Carlito/Caladea —
// font-fidelity tier 1, core/font-decide.js) are spread in from
// clone-fonts.js: routed by /BaseFont for substitution AND offered in the
// font dropdown as authoring choices (founder ruling 2026-07-20 evening;
// docs/spec-font-fidelity-engine.md (deleted 2026-10-01; git log -- docs/spec-font-fidelity-engine.md) §3) — core/stamp.js's rung-2 clone ladder
// needs the EXACT same weight-file mapping to fetch the same TTF this
// module would, so it's factored into one shared source rather than kept as
// two copies.
const FONT_NAME_MAP = {
  'Helvetica':   { '00': 'Helvetica', '10': 'HelveticaBold', '01': 'HelveticaOblique', '11': 'HelveticaBoldOblique' },
  'Times-Roman': { '00': 'TimesRoman', '10': 'TimesRomanBold', '01': 'TimesRomanItalic', '11': 'TimesRomanBoldItalic' },
  'Courier':     { '00': 'Courier', '10': 'CourierBold', '01': 'CourierOblique', '11': 'CourierBoldOblique' },
  'Montserrat':  { '00': 'Montserrat', '10': 'Montserrat-Bold', '01': 'Montserrat-Italic', '11': 'Montserrat-BoldItalic' },
  ...CLONE_FONT_VARIANTS,
};

export const CUSTOM_FONT_URLS = {
  'Montserrat': '/fonts/ttf/montserrat-regular.ttf',
  'Montserrat-Bold': '/fonts/ttf/montserrat-bold.ttf',
  'Montserrat-Italic': '/fonts/ttf/montserrat-italic.ttf',
  'Montserrat-BoldItalic': '/fonts/ttf/montserrat-bolditalic.ttf',
  ...CLONE_FONT_URLS,
};

const CUSTOM_FONT_FAMILIES = new Set(['Montserrat', 'Carlito', 'Arimo', 'Tinos', 'Cousine', 'Caladea']);

// WHY: AbortController timeout prevents export from hanging indefinitely if a
// self-hosted font file fails to load (e.g. offline, 404). Same guard as the
// old editor export (security hardening, Mar 2026).
const FONT_FETCH_TIMEOUT_MS = 10000;

function resolveFontName(fontFamily, bold, italic) {
  const variant = `${bold ? '1' : '0'}${italic ? '1' : '0'}`;
  const family = FONT_NAME_MAP[fontFamily];
  if (family) return { name: family[variant], isCustom: CUSTOM_FONT_FAMILIES.has(fontFamily) };
  console.warn('[core/export] Unknown font family:', fontFamily, '- falling back to Helvetica');
  return { name: FONT_NAME_MAP['Helvetica'][variant], isCustom: false };
}

async function cacheFallbackFont(env, fontName, bold) {
  // SAY SO, DON'T JUST DO IT (maintenance audit 2026-08-09, finding 2): this
  // fallback changes the typeface in the file the user KEEPS — glyphs and
  // widths differ from the preview — and until now its only witness was the
  // user's own console. Core is headless, so it cannot toast; the caller
  // injects deps.onFontFallback and owns the user-facing signal
  // (download-sheet toasts + fires the rail's failure{reason:'font-fallback',
  // blocked:false} forewarning). Fires once per font name per export: later
  // annotations hit the fontCache directly and never re-enter this function.
  try { env.onFontFallback?.(fontName); } catch { /* reporting must never break the export */ }
  // WHY 'HelveticaBold' (no hyphen): PDFLib.StandardFonts KEYS are camel-case
  // ('HelveticaBold'); the hyphenated form is the enum VALUE. The old export
  // used the value as a key here, silently getting `undefined` for bold
  // fallbacks — fixed in this port.
  const fallbackName = bold ? 'HelveticaBold' : 'Helvetica';
  if (!env.fontCache[fallbackName]) {
    env.fontCache[fallbackName] = await env.newDoc.embedFont(env.PDFLib.StandardFonts[fallbackName]);
  }
  // WHY: also cache under the REQUESTED name so later annotations using the
  // failed font hit the cache instead of re-waiting the full fetch timeout ×N.
  env.fontCache[fontName] = env.fontCache[fallbackName];
  return env.fontCache[fontName];
}

async function embedCustomFont(env, fontName, bold) {
  // WHY guards: custom fonts need fontkit (for embedFont on raw bytes) and a
  // fetch-capable environment. A headless caller injecting only PDFLib still
  // gets a valid PDF — the text falls back to Helvetica instead of throwing.
  if (!env.fontkit || typeof fetch !== 'function') {
    console.warn('[core/export] fontkit/fetch unavailable, Helvetica fallback for', fontName);
    return cacheFallbackFont(env, fontName, bold);
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS);
    const res = await fetch(CUSTOM_FONT_URLS[fontName], { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fontBytes = await res.arrayBuffer();
    // A web container here would embed verbatim and paint as dots outside
    // pdf.js — the Helvetica fallback, WITH its witness, is the honest result.
    if (!isSfntFontProgram(new Uint8Array(fontBytes))) throw new Error('not an sfnt font program');
    env.fontCache[fontName] = await env.newDoc.embedFont(fontBytes);
    return env.fontCache[fontName];
  } catch (err) {
    console.error('[core/export] Failed to load font:', fontName, err);
    return cacheFallbackFont(env, fontName, bold);
  }
}

async function embedStandardFont(env, fontName, bold) {
  const std = env.PDFLib.StandardFonts[fontName];
  if (!std) {
    console.error('[core/export] Invalid standard font name:', fontName);
    return cacheFallbackFont(env, fontName, bold);
  }
  env.fontCache[fontName] = await env.newDoc.embedFont(std);
  return env.fontCache[fontName];
}

async function getFont(env, fontFamily, bold, italic) {
  const { name, isCustom } = resolveFontName(fontFamily || 'Helvetica', bold, italic);
  if (env.fontCache[name]) return env.fontCache[name];
  return isCustom ? embedCustomFont(env, name, bold) : embedStandardFont(env, name, bold);
}

// ---- coordinate transforms --------------------------------------------------

// WHY: Map a point from the rotated page frame (top-left origin, Y-down, in
// points) to the unrotated PDF frame (bottom-left origin, Y-up). Ported from
// the old editor export (golden-tested there) minus the canvas scale factors.
// Pair with `rotate: degrees(rotation)` on drawText/drawImage so glyphs/images
// are oriented correctly after the page is /Rotate'd. wU/hU are the UNROTATED
// dims of the VISIBLE box and (x0, y0) its origin: see visibleBox below.
function transformAnnotationCoords(rotation, xV, yV, wU, hU, x0 = 0, y0 = 0) {
  switch (rotation) {
    case 90:  return { x: x0 + yV,      y: y0 + xV };
    case 180: return { x: x0 + wU - xV, y: y0 + yV };
    case 270: return { x: x0 + wU - yV, y: y0 + hU - xV };
    default:  return { x: x0 + xV,      y: y0 + hU - yV };
  }
}

// A TURNED OBJECT (founder ruling 2026-10-11, "semua harus ngikut rotasi"):
// text and signatures carry `turn`, the quarter turns their page made under
// them (core/annotation-geometry.js turnAnnotation), and (x, y) is their
// ORIGIN, the point the screen rotates them about (render/page-view.js
// applyTurn). pdf-lib rotates a drawing about its own anchor (a text's
// baseline-left, an image's bottom-left), so every drawer names that anchor
// as an offset (px, py) in the object's OWN unturned frame, objectPoint turns
// the offset with the object and maps it into PDF space, and objectRotate
// gives the angle: pdf-lib's rotate is counter-clockwise in PDF space, the
// reader's /Rotate and `turn` are clockwise on screen, so the page's R minus
// the object's turn. Unturned (turn 0) both reduce to the old calls exactly.
function objectPoint(anno, px, py, frame) {
  const v = turnVector(turnOf(anno), px, py);
  return transformAnnotationCoords(frame.rotation, (anno.x || 0) + v.x, (anno.y || 0) + v.y,
    frame.wU, frame.hU, frame.x0, frame.y0);
}
function objectRotate(anno, frame, PDFLib) {
  return PDFLib.degrees((((frame.rotation - turnOf(anno)) % 360) + 360) % 360);
}

// SINGLE SOURCE OF TRUTH for the box annotations are drawn into: the CropBox
// clipped to the MediaBox, which is exactly the viewport PDF.js gave the
// editor (the frame every annotation coordinate was measured in). Using the
// MediaBox from (0,0) shifted every annotation on a cropped page by the crop
// origin: a Tip-Ex at the visible top-left landed outside the visible area
// (round-3 hunt, 2026-10-10; tests/core/export-cropbox.test.mjs).
function visibleBox(pdfPage) {
  const m = normalizedBox(pdfPage.getMediaBox());
  const c = normalizedBox(pdfPage.getCropBox());
  const x0 = Math.max(m.x, c.x);
  const y0 = Math.max(m.y, c.y);
  const x1 = Math.min(m.x + m.width, c.x + c.width);
  const y1 = Math.min(m.y + m.height, c.y + c.height);
  if (!(x1 > x0 && y1 > y0)) return { x0: m.x, y0: m.y, wU: m.width, hU: m.height }; // degenerate crop: PDF.js falls back too
  return { x0, y0, wU: x1 - x0, hU: y1 - y0 };
}

// A PDF rectangle may list its corners in any order ([0 792 612 0] is legal)
// and PDF.js takes min/max, so the editor showed the page upright. pdf-lib's
// getMediaBox/getCropBox return the raw numbers (negative height), the
// intersection above came out empty, and every edit was drawn off the page.
function normalizedBox({ x, y, width, height }) {
  return { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
}

// Whiteout: pdf-lib drawRectangle is axis-aligned in the unrotated page frame.
// For 90°/270° page rotations the view-horizontal direction maps to
// PDF-vertical, so width and height swap. The anchor is the corner of the
// view-space rect that becomes the bottom-left of the unrotated PDF rect
// after the rotation transform (verify each case by hand against
// transformAnnotationCoords).
function whiteoutCornerAndDims(rotation, anno, wU, hU, x0 = 0, y0 = 0) {
  const { x: xC, y: yC, width: wC, height: hC } = anno;
  switch (rotation) {
    case 90: {  // view TL → PDF bottom-left
      const { x, y } = transformAnnotationCoords(90, xC, yC, wU, hU, x0, y0);
      return { x, y, width: hC, height: wC };
    }
    case 180: {  // view TR → PDF bottom-left
      const { x, y } = transformAnnotationCoords(180, xC + wC, yC, wU, hU, x0, y0);
      return { x, y, width: wC, height: hC };
    }
    case 270: {  // view BR → PDF bottom-left
      const { x, y } = transformAnnotationCoords(270, xC + wC, yC + hC, wU, hU, x0, y0);
      return { x, y, width: hC, height: wC };
    }
    default: {  // rotation 0: view BL → PDF bottom-left
      const { x, y } = transformAnnotationCoords(0, xC, yC + hC, wU, hU, x0, y0);
      return { x, y, width: wC, height: hC };
    }
  }
}

// ---- per-type drawers --------------------------------------------------------

function parseHexColor(PDFLib, hex) {
  const h = (hex || '#000000').replace('#', '');
  return PDFLib.rgb(
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  );
}

// WHY these ratios: core text `y` is the TOP of the text block (page-view.js
// lays text out as a DOM element with CSS line-height 1.2), but pdf-lib's
// drawText anchors at the BASELINE. First baseline sits ≈ half-leading (0.1em)
// + typical Latin ascent (0.8em) below the block top. The old export skipped
// this because its `y` WAS the canvas fillText baseline — the new core stores
// box tops, so the offset moves here.
const TEXT_BASELINE_RATIO = 0.9;
const TEXT_LINE_HEIGHT = 1.2; // must match page-view.js CSS line-height

// SINGLE SOURCE OF TRUTH for each drawer's fallback font size, hoisted out of
// the drawers so scaleAnnotationGeometry can reach them.
//
// WHY that matters: a default is expressed in the annotation's OWN frame,
// which after a merge is the NORMALISED frame. If the default were left to be
// applied inside the drawer, it would be applied to a page that is about to be
// scaled by `factor`, and would paint `factor`× too large — a footgun that
// only appears on merged documents, i.e. never in a single-file test. v2 always
// sets `fontSize` on the text annotations it creates (js/v2/app.js), and
// watermark/pageNumber are not reachable from v2 at all today, so this closes
// the class rather than a live bug. Keep the numbers here and nowhere else.
const DEFAULT_FONT_SIZE = { text: 16, watermark: 48, pageNumber: 12 };

async function drawWhiteout(pdfPage, anno, frame, env) {
  if (anno.ocrBox && anno.paperImage) {
    await drawSignature(pdfPage, { ...anno, image: anno.paperImage }, frame, env);
    return;
  }
  const r = whiteoutCornerAndDims(frame.rotation, anno, frame.wU, frame.hU, frame.x0, frame.y0);
  // Color-matched Tip-Ex: anno.color is sampled from the page background at
  // draw time (app layer). White stays the default for plain documents.
  const color = anno.color ? parseHexColor(env.PDFLib, anno.color) : env.PDFLib.rgb(1, 1, 1);
  pdfPage.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color });
}

// Can THIS embedded font paint every character of `text`? Two font kinds, two
// honest answers: a custom/clone font (embedded through fontkit) exposes its
// own cmap, so ask it glyph by glyph — pdf-lib would NOT throw for a missing
// one, it paints .notdef, the silent tofu this check exists to catch. A
// standard font has no cmap to ask; its ceiling is WinAnsi, and
// text-encode.js already derives that set against the real vendored pdf-lib.
// Detected from the font object itself, never from the family name: a failed
// clone fetch hands back a STANDARD font under a custom family's name
// (cacheFallbackFont), and asking the name would say "custom" about a font
// that is about to throw WinAnsi.
function fontCanPaint(font, text) {
  const fk = font?.embedder?.font;
  if (typeof fk?.hasGlyphForCodePoint === 'function') {
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') continue;
      if (!fk.hasGlyphForCodePoint(ch.codePointAt(0))) return false;
    }
    return true;
  }
  return unencodableInStandardFont(text).length === 0;
}

// THE GLYPH FALLBACK (2026-09-06). A character the PDF font cannot paint used
// to abort the ENTIRE export: measured on the rail 2026-08-23..09-05, six
// sessions hit `export/unsupported`, five exported nothing, one user retried
// 24 times. Every one had seen the character painted correctly on screen,
// because the screen uses the browser's fonts. So when the adapter injects a
// rasteriser (js/v2/text-raster.js — same font string the overlay used), THIS
// annotation alone is embedded as an image at the exact place and size the
// text would have gone; every other annotation stays real text. Headless
// callers inject nothing and keep the old behaviour: the throw.
//
// This supersedes the 2026-07-29 "warn at commit, keep the export decline as
// the backstop" ruling, which was made with zero data. The data says the
// backstop was the wall. Seat ruling + receipts: ../decisions.md 2026-09-06.
async function drawTextAsImage(pdfPage, anno, frame, env, text) {
  let raster = null;
  try {
    raster = await env.rasterizeText({ ...anno, text });
  } catch (err) {
    console.warn('[core/export] text raster failed, falling back to drawText:', err);
    return false;
  }
  if (!raster || !raster.png || !(raster.width > 0) || !(raster.height > 0)) return false;
  const img = await env.newDoc.embedPng(raster.png);
  // Anchor at the BOTTOM-LEFT of the block in its own frame, exactly like drawSignature.
  const { x, y } = objectPoint(anno, 0, raster.height, frame);
  pdfPage.drawImage(img, {
    x, y, width: raster.width, height: raster.height, rotate: objectRotate(anno, frame, env.PDFLib),
  });
  return true;
}

// A Ganti replacement whose stamp did NOT bake (its cover's surgery declined:
// no match, a moved cover, an encrypted source) still carries the font the
// user watched while typing (core/line-font.js). Draw it in THAT font — the
// doc's own program off this copied page, or the bundled TTF — re-verified by
// the same resolveDecidedFont the stamp uses. Before 2026-10-01 this path drew
// the twin's family, which for most edits was whole-line Helvetica: a face the
// user never saw. null = no decision, or it did not verify → the twin as before.
async function decidedFontFor(pdfPage, anno, env, text) {
  if (!anno.replaceCoverId || !anno.fontDecision || !env.fontkit) return null;
  const r = await resolveDecidedFont(pdfPage, env.PDFLib, env.fontkit, anno.fontDecision, text);
  return r.ok ? r.font : null;
}

// RUNG D: a whole-paragraph edit whose stamp did not bake (its cover's
// surgery declined) still draws its painted lines at the block's own leading
// and alignment — never at the twin's 1.2 line height from `anno.y`. Same
// placement function the stamp uses (core/block-edit.js), with this font's
// widths, laid out in the block's own PDF units.
//
// It is DRAWN where the overlay rows paint (render/page-view.js
// renderBlockRows): that overlay is the user's to drag, resize and turn the
// page under, so the lines go through the displayed frame like every other
// annotation, anchored at block.disp (the first baseline, carried by every
// move, turn and rescale, core/annotation-geometry.js), at the annotation's
// fontSize, turned with its page (objectPoint, since 2026-10-11). Drawing
// them at block.origin, as this did until
// 2026-10-10, threw all three away on download. Unmoved, the two agree.
async function drawBlockText(pdfPage, anno, env) {
  const block = anno.block;
  const joined = toStandardFontSafe(blockText(block));
  const font = await decidedFontFor(pdfPage, anno, env, joined)
    || await env.getFont(anno.fontFamily, anno.bold, anno.italic);
  const color = parseHexColor(env.PDFLib, anno.color);
  if (typeof env.rasterizeText === 'function' && !fontCanPaint(font, joined)) {
    const asLines = block.lines.map((l) => l.text).join('\n');
    if (await drawTextAsImage(pdfPage, { ...anno, fontSize: anno.fontSize || DEFAULT_FONT_SIZE.text }, env.frame, env, asLines)) return;
  }
  // A block with no display anchor cannot have been moved by the user; one
  // missing field must not abort the whole export, so it keeps its birth spot.
  if (!block.disp) {
    const widthOf = (str) => font.widthOfTextAtSize(toStandardFontSafe(str), block.size);
    for (const line of placeBlockLines(block, widthOf)) {
      for (const seg of line.segments) drawTextSafe(pdfPage, seg.text, { x: seg.x, y: line.y, size: block.size, font, color });
    }
    return;
  }
  const { frame } = env;
  const k = block.k > 0 ? block.k : 1;
  // The size the overlay paints, in the block's PDF units: block.size until
  // a resize (commit sets fontSize = k * size, js/v2/app.js).
  const size = (anno.fontSize > 0 ? anno.fontSize : k * block.size) / k;
  const widthOf = (str) => font.widthOfTextAtSize(toStandardFontSafe(str), size);
  const rotate = objectRotate(anno, frame, env.PDFLib);
  // disp - (x, y) is the first baseline's offset in the block's OWN frame
  // (core/annotation-geometry.js withBlockFollowing), so each segment is an
  // own-frame offset from the origin, turned by objectPoint.
  const ox = block.disp.x - (anno.x || 0);
  const oy = block.disp.y - (anno.y || 0);
  for (const line of placeBlockLines(block, widthOf)) {
    for (const seg of line.segments) {
      const { x, y } = objectPoint(anno, ox + k * (seg.x - block.origin.x), oy + k * (block.origin.y - line.y), frame);
      drawTextSafe(pdfPage, seg.text, { x, y, size: size * k, font, color, rotate });
    }
  }
}

async function drawText(pdfPage, anno, frame, env) {
  if (anno.block && Array.isArray(anno.block.lines) && anno.block.lines.length) {
    await drawBlockText(pdfPage, anno, { ...env, frame });
    return;
  }
  const font = await decidedFontFor(pdfPage, anno, env, toStandardFontSafe(anno.text))
    || await env.getFont(anno.fontFamily, anno.bold, anno.italic);
  const color = parseHexColor(env.PDFLib, anno.color);
  const rotate = objectRotate(anno, frame, env.PDFLib);
  const size = anno.fontSize || DEFAULT_FONT_SIZE.text;
  // Normalise the invisible half of pasted text BEFORE pdf-lib sees it. A
  // standard font encodes through WinAnsi, and one codepoint outside it throws
  // a bare Error that aborts the ENTIRE export — there is no per-annotation
  // guard in the loop below, so one thin space in one of 174 annotations loses
  // the whole document. That is the 2026-07-28 incident (41 failed downloads,
  // 82 minutes of work). Applied to custom fonts too: they do not throw, they
  // paint .notdef, and a real space beats a tofu box.
  const safeText = toStandardFontSafe(anno.text);
  if (typeof env.rasterizeText === 'function' && !fontCanPaint(font, safeText)) {
    if (await drawTextAsImage(pdfPage, { ...anno, fontSize: size }, frame, env, safeText)) return;
  }
  const lines = safeText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const { x, y } = objectPoint(anno, 0, size * TEXT_BASELINE_RATIO + i * size * TEXT_LINE_HEIGHT, frame);
    drawTextSafe(pdfPage, lines[i], { x, y, size, font, color, rotate });
  }
}

async function drawSignature(pdfPage, anno, frame, env) {
  // WHY cache by dataUrl: "Paraf → Semua Hal." stamps the SAME image on every
  // page — embed it once, reference it N times (smaller file, faster export).
  let img = env.imageCache.get(anno.image);
  if (!img) {
    // Format-aware embedding: JPEG re-encoded as PNG would bloat the file.
    img = anno.image.startsWith('data:image/jpeg')
      ? await env.newDoc.embedJpg(anno.image)
      : await env.newDoc.embedPng(anno.image);
    env.imageCache.set(anno.image, img);
  }
  const width = anno.width || img.width;
  // WHY: page-view.js renders signatures with height:auto — `height` may be
  // absent on the annotation. Derive it from the embedded image's intrinsic
  // aspect ratio so the export never distorts the signature.
  const height = anno.height || width * (img.height / img.width);
  // Anchor pdf-lib drawImage at the BOTTOM-LEFT of the image in its own
  // frame: turned with the object and transformed through the page rotation,
  // this lands the visible image exactly where the user sees it. (A scan
  // cover's paper patch comes through here too; a whiteout has no turn.)
  const { x, y } = objectPoint(anno, 0, height, frame);
  pdfPage.drawImage(img, { x, y, width, height, rotate: objectRotate(anno, frame, env.PDFLib) });
}

async function drawWatermark(pdfPage, anno, frame, env) {
  const font = await env.getFont('Helvetica', false, false);
  const size = anno.fontSize || DEFAULT_FONT_SIZE.watermark;
  // Watermark has its own user-specified tilt; combine with the page rotation
  // so the visible tilt matches what the user saw in the editor.
  const totalDeg = frame.rotation + (anno.rotation || 0);
  const rad = (totalDeg * Math.PI) / 180;
  // WHY centering math: the editor preview draws the watermark with
  // textAlign:center + textBaseline:middle — (x, y) is the text CENTER.
  // pdf-lib anchors at baseline-LEFT and rotates AROUND that anchor, so back
  // the anchor off by half the text extent, rotated by the total tilt.
  // 0.35em ≈ cap-height/2 (baseline→optical-center distance).
  const halfW = font.widthOfTextAtSize(anno.text || '', size) / 2;
  const halfCap = size * 0.35;
  const { x: cx, y: cy } = transformAnnotationCoords(frame.rotation, anno.x, anno.y, frame.wU, frame.hU, frame.x0, frame.y0);
  drawTextSafe(pdfPage, anno.text || '', {
    x: cx - halfW * Math.cos(rad) + halfCap * Math.sin(rad),
    y: cy - halfW * Math.sin(rad) - halfCap * Math.cos(rad),
    size,
    font,
    color: parseHexColor(env.PDFLib, anno.color),
    opacity: anno.opacity ?? 0.3,
    rotate: env.PDFLib.degrees(totalDeg),
  });
}

async function drawPageNumber(pdfPage, anno, frame, env) {
  // A pageNumber is a single-line label with the same coordinate contract as
  // text (y = top of the line box). The old export silently DROPPED this type
  // (missing branch in embedAnnotationsOnPage) — fixed in this port.
  const font = await env.getFont('Helvetica', false, false);
  const size = anno.fontSize || DEFAULT_FONT_SIZE.pageNumber;
  const yV = anno.y + size * TEXT_BASELINE_RATIO;
  const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU, frame.x0, frame.y0);
  drawTextSafe(pdfPage, anno.text || '', {
    x, y, size, font,
    color: parseHexColor(env.PDFLib, anno.color),
    rotate: env.PDFLib.degrees(frame.rotation),
  });
}

// Handler map instead of an if/else chain (same pattern as the SonarQube
// sprint's handler maps). Unknown types warn-and-skip so one bad annotation
// can't kill a whole export.
const ANNOTATION_DRAWERS = {
  whiteout: drawWhiteout,
  text: drawText,
  signature: drawSignature,
  watermark: drawWatermark,
  pageNumber: drawPageNumber,
};

// ---- image pages -------------------------------------------------------------

// A page whose source is an IMAGE file: create a blank PDF page at the page's
// point size and draw the image edge-to-edge.
async function addImagePage(env, page, source) {
  const fmt = sniffImageFormat(source.bytes);
  // WHY throw: pdf-lib decodes only PNG and JPEG. WEBP/GIF sources must be
  // transcoded to PNG at import time (canvas → toBlob) — by the time bytes
  // reach export they must be one of the two. Fail loudly instead of emitting
  // a broken PDF.
  if (!fmt) throw new Error(`buildPdfBytes: image source "${source.name}" is not PNG/JPEG`);
  const img = fmt === 'jpg' ? await env.newDoc.embedJpg(source.bytes) : await env.newDoc.embedPng(source.bytes);
  const pdfPage = env.newDoc.addPage([page.width, page.height]);
  pdfPage.drawImage(img, { x: 0, y: 0, width: page.width, height: page.height });
  return pdfPage;
}

// ---- merge width normalisation ------------------------------------------------

// Annotation coordinates live in the page's NORMALISED display frame; the
// drawers express them back in the source page's NATIVE frame by scaling with
// 1 / pageScale, drawing alongside the original content, and then scaling the
// finished page up in one uniform move (see the ordering argument in
// buildPdfBytes). The scaling itself is core/annotation-geometry.js's, the one
// home of that frame contract. Surgery inputs (replaceBox/replaceTargets) are
// native already and are never scaled: applyPageSurgery reads the untouched list.

// pdf-lib's page.scale() resizes the MediaBox from ITS ORIGIN (the origin
// itself is not scaled, though the content is, about 0,0) and only moves a
// Crop/Bleed/Trim/ArtBox that equals the MediaBox. A distinct CropBox stayed
// at native size, so a merge-rescaled cropped page showed a shifted, zoomed-in
// piece of itself. Every box present is scaled about 0,0, with the content.
const PAGE_BOXES = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];
function scalePageWithBoxes(pdfPage, k) {
  const before = PAGE_BOXES
    .filter((name) => name === 'MediaBox' || pdfPage.node[name]?.())
    .map((name) => [name, pdfPage[`get${name}`]()]);
  pdfPage.scale(k, k);
  for (const [name, b] of before) pdfPage[`set${name}`](b.x * k, b.y * k, b.width * k, b.height * k);
}

// ---- the source's own annotations, under the user's objects -----------------

// WHY: the screen and the file paint a source annotation in different places.
// import.js rasterizes with pdf.js's default annotationMode, which paints every
// viewable annotation's /AP INTO the page image, and the user's objects sit in
// an overlay above it. The export draws the user's objects into the page
// CONTENT, and a reader paints /Annots AFTER the content: a filled form field
// copied across verbatim landed ON TOP of the Tip-Ex meant to hide it, and the
// correction typed over it disappeared under the field's box
// (tests/core/export-annots-under-cover.test.mjs). So each annotation pdf.js
// painted whose /Rect meets a user object's drawn rect (userObjectRects) is
// drawn into the content first, from its OWN appearance (never regenerated:
// that would change how it looks), and taken out of /Annots. Everything else
// stays live, on this page and on every page without user objects: flattening
// costs an annotation its interaction, so it is spent only where the cover
// needs it. The output never had the source's /AcroForm (newDoc is created
// empty), so a flattened widget loses no fillability it still had.
//
// Not flattened, so left exactly as before, even under a cover: Link and
// Popup (interaction, not paint; a Popup leaves only with its flattened
// parent); FileAttachment, Text (sticky note) and the media kinds, whose point
// is a file, a comment or a player, not their icon; Hidden or NoView (pdf.js
// does not paint them); NoRotate (it stays upright on a turned page, which
// drawn content cannot); one without the Print flag (a reader shows it but
// never prints it, and as content it would start printing); and anything
// without an /AP pdf.js would pick (it may synthesize one we cannot see).
const KEEP_AS_ANNOTATION = new Set([
  'Link', 'Popup', 'FileAttachment', 'Text', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D',
]);
const FLAG_HIDDEN = 1 << 1;
const FLAG_PRINT = 1 << 2;
const FLAG_NO_ROTATE = 1 << 4;
const FLAG_NO_VIEW = 1 << 5;

// The ref of the appearance stream pdf.js would paint, or null. A /N that is a
// dict of states is chosen by /AS, and no /AS means no appearance (pdf.js's
// own rule, so screen and file agree on checkboxes and radios).
function paintedAppearanceRef(annot, PDFLib) {
  const { PDFName, PDFDict, PDFStream, PDFRef, PDFNumber } = PDFLib;
  if (KEEP_AS_ANNOTATION.has(annot.lookup(PDFName.of('Subtype'))?.decodeText?.())) return null;
  const flags = annot.lookup(PDFName.of('F'));
  const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
  if (f & (FLAG_HIDDEN | FLAG_NO_VIEW | FLAG_NO_ROTATE)) return null;
  if (!(f & FLAG_PRINT)) return null;
  const ap = annot.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return null;
  let raw = ap.get(PDFName.of('N'));
  const n = annot.context.lookup(raw);
  if (n instanceof PDFDict && !(n instanceof PDFStream)) {
    const state = annot.lookup(PDFName.of('AS'));
    if (!(state instanceof PDFName)) return null;
    raw = n.get(state);
  }
  if (!(annot.context.lookup(raw) instanceof PDFStream)) return null;
  return raw instanceof PDFRef ? raw : annot.context.register(annot.context.lookup(raw));
}

// A reader paints an annotation's appearance without asking its /Subtype,
// but a content Do needs a Form XObject (pdf.js drops anything else: "XObject
// should have a Name subtype"), so an appearance that omits it would vanish
// once flattened. A missing /Subtype is supplied (this is newDoc's copy, never
// the source); one naming something else is not a form at all, so the
// annotation stays live. False = do not flatten.
function asFormXObject(stream, PDFLib) {
  const { PDFName } = PDFLib;
  const sub = stream.dict.get(PDFName.of('Subtype'));
  if (sub === undefined) {
    stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    return true;
  }
  return sub === PDFName.of('Form');
}

// ISO 32000 §12.5.5: the appearance's BBox, carried through its own /Matrix,
// is scaled and translated onto /Rect. Do applies the form's /Matrix itself,
// so the cm is that fit alone. Null for a degenerate box.
function appearanceFit(annot, stream, PDFLib) {
  const { PDFName, PDFArray, PDFNumber } = PDFLib;
  const nums = (arr, n) => {
    if (!(arr instanceof PDFArray) || arr.size() !== n) return null;
    const out = arr.asArray().map((v) => annot.context.lookup(v)).map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN));
    return out.every(Number.isFinite) ? out : null;
  };
  const rect = nums(annot.lookup(PDFName.of('Rect')), 4);
  const bbox = nums(stream.dict.lookup(PDFName.of('BBox')), 4);
  if (!rect || !bbox) return null;
  const [a, b, c, d, e, f] = nums(stream.dict.lookup(PDFName.of('Matrix')), 6) || [1, 0, 0, 1, 0, 0];
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const [tx0, tx1, ty0, ty1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [rx0, rx1] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2])];
  const [ry0, ry1] = [Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
  if (!(tx1 > tx0 && ty1 > ty0)) return null;
  const sx = (rx1 - rx0) / (tx1 - tx0);
  const sy = (ry1 - ry0) / (ty1 - ty0);
  return [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
}

// The PDF-space box [x0, y0, x1, y1] each user object paints, in the frame
// the drawers use (transformAnnotationCoords, visibleBox), so a turned or
// cropped page is measured where the drawing lands. Each corner of the
// view-space box goes through the transform: on a quarter-turned page width
// and height trade axes. Text stores no extent; extentOf's 0.6em estimate is
// the one rotation already uses, and erring wide errs toward covering. A
// watermark (unreachable from v2) is bounded by the circle its tilt sweeps.
function userObjectRects(annos, frame) {
  const rects = [];
  for (const anno of annos) {
    let box;
    if (anno.type === 'watermark') {
      const size = anno.fontSize || DEFAULT_FONT_SIZE.watermark;
      const r = Math.hypot(((anno.text || '').length * size * 0.6) / 2, size / 2);
      box = { x: anno.x - r, y: anno.y - r, w: 2 * r, h: 2 * r };
    } else {
      const asText = anno.type === 'pageNumber'
        ? { ...anno, type: 'text', fontSize: anno.fontSize || DEFAULT_FONT_SIZE.pageNumber }
        : anno;
      // A turned object's box trades axes about its origin (displayedBox).
      box = displayedBox(anno, extentOf(asText));
    }
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || !(box.w > 0 && box.h > 0)) continue;
    const pts = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
      .map(([x, y]) => transformAnnotationCoords(frame.rotation, x, y, frame.wU, frame.hU, frame.x0, frame.y0));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

// Does the annotation's /Rect share area with any of `rects`? Touching edges
// do not count. /Rect corners are not guaranteed to be ordered.
function meetsAny(annot, rects, PDFLib) {
  const { PDFName, PDFArray, PDFNumber } = PDFLib;
  const arr = annot.lookup(PDFName.of('Rect'));
  if (!(arr instanceof PDFArray) || arr.size() !== 4) return false;
  const r = arr.asArray().map((v) => annot.context.lookup(v)).map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN));
  if (!r.every(Number.isFinite)) return false;
  const [ax0, ax1] = [Math.min(r[0], r[2]), Math.max(r[0], r[2])];
  const [ay0, ay1] = [Math.min(r[1], r[3]), Math.max(r[1], r[3])];
  return rects.some(([x0, y0, x1, y1]) => ax0 < x1 && x0 < ax1 && ay0 < y1 && y0 < ay1);
}

// The annotation's own opacity as [stroke, fill], or null when it is opaque.
// A reader applies a live annotation's /CA to its appearance; drawn bare, a
// translucent highlight would turn opaque and hide the text under it. PDF 1.x
// /CA covers both; PDF 2.0's /ca, when present, is the fill's own. (pdf.js
// 3.11 ignores both on screen, so this follows Acrobat and Preview, not the
// raster.)
function annotationOpacity(annot, PDFLib) {
  const { PDFName, PDFNumber } = PDFLib;
  const num = (key) => {
    const v = annot.lookup(PDFName.of(key));
    return v instanceof PDFNumber && Number.isFinite(v.asNumber()) ? Math.min(Math.max(v.asNumber(), 0), 1) : null;
  };
  const stroke = num('CA') ?? 1;
  const fill = num('ca') ?? stroke;
  return stroke < 1 || fill < 1 ? [stroke, fill] : null;
}

// In /Annots order, the order a reader (and pdf.js) paints them. `rects`:
// userObjectRects for the objects about to be drawn on this page.
function flattenPaintedAnnotations(pdfPage, PDFLib, rects) {
  const { PDFName, PDFArray, PDFDict } = PDFLib;
  const annots = pdfPage.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray) || rects.length === 0) return;
  const ctx = pdfPage.doc.context;
  const gone = new Set();
  for (const entry of annots.asArray()) {
    const annot = ctx.lookup(entry);
    if (!(annot instanceof PDFDict) || !meetsAny(annot, rects, PDFLib)) continue;
    const ref = paintedAppearanceRef(annot, PDFLib);
    const fit = ref && appearanceFit(annot, ctx.lookup(ref), PDFLib);
    if (!fit || !asFormXObject(ctx.lookup(ref), PDFLib)) continue;
    const name = pdfPage.node.newXObject('FlatAnnot', ref);
    const alpha = annotationOpacity(annot, PDFLib);
    const gs = alpha && pdfPage.node.newExtGState('FlatAnnotGS', ctx.obj({ Type: 'ExtGState', CA: alpha[0], ca: alpha[1] }));
    pdfPage.pushOperators(
      PDFLib.pushGraphicsState(),
      ...(gs ? [PDFLib.setGraphicsState(gs)] : []),
      PDFLib.concatTransformationMatrix(...fit),
      PDFLib.drawObject(name),
      PDFLib.popGraphicsState(),
    );
    gone.add(entry);
    // Its comment window would be left pointing at nothing.
    const popup = annot.get(PDFName.of('Popup'));
    if (popup) gone.add(popup);
  }
  if (gone.size === 0) return;
  const kept = annots.asArray().filter((entry) => !gone.has(entry));
  pdfPage.node.set(PDFName.of('Annots'), ctx.obj(kept));
}

// ---- pass-through: the untouched document -----------------------------------

// Is this Doc PROVABLY the source file, unchanged? Returns the Source whose
// bytes are the whole truth, or null.
//
// WHY THIS EXISTS, and it is not an optimisation. Everything below rebuilds
// the document: copyPages into a fresh PDFDocument, then `newDoc.save(...)`.
// There is no incremental-update path anywhere in this stack. For an ordinary
// PDF that is invisible. For a document carrying an Indonesian e-meterai or
// any PAdES digital signature it is destruction: the signature digests a byte
// range of the ORIGINAL file, and a rebuild moves every byte. The visible
// meterai graphic survives as page content, so the output looks perfectly
// stamped and fails Peruri verification — the user finds out somewhere else,
// days later, which is the exact failure mode core/import.js refuses
// `ignoreEncryption` for. Handing back the original bytes is the only real
// fix; a warning is what we do when we cannot.
//
// SIDE BENEFIT, deliberate: an untouched ENCRYPTED PDF now downloads instead
// of being refused. pdf-lib has no decryption and throws at
// `PDFDocument.load` — but we are no longer asking it to load anything, and
// the bytes we hand back are the user's own encrypted file, byte for byte. We
// decrypt nothing and claim to remove nothing. (The refusal remains honest the
// moment anything below stops holding: then a rebuild really is required, and
// pdf-lib really cannot do it.)
//
// ⚠️ STRICT, NOT CLEVER. Every condition below is a thing that would otherwise
// silently vanish from the user's file, and the cost of being wrong is
// asymmetric: a missed pass-through costs a seal that was already doomed, a
// wrong pass-through silently drops work the user did. So when in doubt,
// rebuild. Do not relax one of these into "usually fine".
export function passThroughSource(doc) {
  const sources = doc?.sources;
  if (!Array.isArray(sources) || sources.length !== 1) return null; // nothing to compose
  const source = sources[0];
  if (!source || !(source.bytes?.length > 0)) return null;
  const pages = doc.pages;
  if (!Array.isArray(pages) || pages.length === 0) return null;
  // EVERY page of the source, in the source's own order, and no others. This
  // one test covers deleted, added, reordered AND deselected-in-the-sheet all
  // at once — the download sheet builds its subset Doc by filtering
  // `doc.pages` (js/v2/download-sheet.js selectedPages), so "page 3 was
  // unticked" arrives here as a pages array that no longer covers the source.
  if (pages.length !== source.numPages) return null;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page || page.isFromImage) return null;              // an image page is not this source
    if (page.sourceId !== source.id) return null;
    if (page.sourcePageNum !== i) return null;               // reordered, or a subset
    if (page.annotations?.length) return null;               // Tip-Ex / teks / TTD / a Ganti edit
    if (totalPageRotation(page) !== (page.baseRotation || 0)) return null; // the user turned it
    // Merge width normalisation (core/operations.js): a page whose display
    // width was rescaled to match an anchor is not its source page any more,
    // even though the pixels came from there. Guarded explicitly rather than
    // left to the one-source test above, so a future single-source normalise
    // cannot walk through here.
    if (page.baseWidth > 0 && page.width !== page.baseWidth) return null;
  }
  return source;
}

// ---- the adapter ---------------------------------------------------------------

// Build final PDF bytes for a core Doc. `deps` injects the vendor libs so the
// module stays vendor-import-free (browser: omit deps, globals are picked up;
// Node: pass { PDFLib, fontkit } explicitly).
export async function buildPdfBytes(doc, deps = {}) {
  const PDFLib = deps.PDFLib || globalThis.PDFLib;
  const fontkit = deps.fontkit || globalThis.fontkit;
  if (!PDFLib) throw new Error('buildPdfBytes: PDFLib is required (inject via deps or load the vendor script)');

  // NOTHING CHANGED → HAND BACK THE ORIGINAL BYTES. See passThroughSource for
  // the whole argument; the short version is that rebuilding an untouched
  // document is not free — it destroys an e-meterai or a digital signature —
  // and there is no version of "rebuild it identically" that keeps a digest
  // taken over the original file's byte offsets.
  //
  // A COPY, not the array itself: callers keep these bytes (the sheet caches
  // them, compress reads them, a Blob wraps them) and must never be handed a
  // view onto the Source's own buffer that a later write could disturb. Same
  // defensive stance as import.js's `bytes.slice()` before PDF.js.
  const untouched = passThroughSource(doc);
  if (untouched) return new Uint8Array(untouched.bytes);

  const newDoc = await PDFLib.PDFDocument.create();
  // fontkit is only needed for custom fonts (Montserrat/Carlito); standard
  // fonts work without it — see the guard in embedCustomFont.
  if (fontkit) newDoc.registerFontkit(fontkit);

  const env = {
    PDFLib, fontkit, newDoc, fontCache: {}, imageCache: new Map(),
    onFontFallback: deps.onFontFallback || null, // see cacheFallbackFont
    rasterizeText: deps.rasterizeText || null,   // see drawTextAsImage
  };
  env.getFont = (family, bold, italic) => getFont(env, family, bold, italic);

  // WHY cache: the old exporter re-parsed the source PDF for EVERY page
  // (O(pages × parse)). One pdf-lib load per source is strictly better.
  const srcDocCache = new Map(); // sourceId → Promise<PDFDocument>
  function getSrcDoc(source) {
    if (!srcDocCache.has(source.id)) srcDocCache.set(source.id, PDFLib.PDFDocument.load(source.bytes));
    return srcDocCache.get(source.id);
  }

  // WHY one copyPages per SOURCE, not per page: every copyPages call is a
  // fresh object copier, so a font or logo shared by all pages of a Word PDF
  // was written into the output once PER PAGE (a 20-page letter with one
  // Tip-Ex grew from ~20 KB to ~320 KB; tests/core/export-shared-resources).
  // One batched call per source shares them. Only a page's FIRST occurrence is
  // batched: a repeated source page takes its own copy below, exactly as
  // before, so two plan slots never share one page object. Surgery is safe on
  // a batched copy: redact.js writes a NEW content stream, never the shared one.
  const plan = buildExportPlan(doc);
  const batched = new Map(); // sourceId → Map(sourcePageNum → copied PDFPage)
  for (const { page, source } of plan) {
    if (!source || page.isFromImage) continue;
    if (!batched.has(source.id)) batched.set(source.id, new Map());
    batched.get(source.id).set(page.sourcePageNum, null);
  }
  for (const [sourceId, byNum] of batched) {
    const source = plan.find((e) => e.source?.id === sourceId).source;
    const nums = [...byNum.keys()];
    const copies = await newDoc.copyPages(await getSrcDoc(source), nums);
    nums.forEach((n, i) => byNum.set(n, copies[i]));
  }

  for (const { page, source, annotations } of plan) {
    if (!source) throw new Error(`buildPdfBytes: page ${page.id} references missing source ${page.sourceId}`);

    let pdfPage;
    if (page.isFromImage) {
      pdfPage = await addImagePage(env, page, source);
    } else {
      const byNum = batched.get(source.id);
      let copied = byNum.get(page.sourcePageNum);
      if (copied) byNum.set(page.sourcePageNum, null); // first occurrence takes the batched copy
      else [copied] = await newDoc.copyPages(await getSrcDoc(source), [page.sourcePageNum]);
      pdfPage = newDoc.addPage(copied);
    }
    // /Rotate — SINGLE SOURCE OF TRUTH for "how is this page turned"
    // (core/page-rotation.js). This used to be `setRotation(page.rotation)`,
    // and setRotation is ABSOLUTE: a source PDF's own inherited /Rotate was
    // thrown away. A document already carrying /Rotate 90, rotated once in the
    // editor, showed 180 on screen (import.js rasterizes at baseRotation +
    // rotation) and exported at 90. Screen and file disagreed, and the user
    // only found out after they had the file. Fixed 2026-08-09.
    const totalRotation = totalPageRotation(page);
    // Write only when it differs from what the copy already carries: every
    // base-0 page (the overwhelming majority, and every image page) keeps
    // byte-identical output, and a copy that DID lose an inherited /Rotate
    // still gets corrected.
    if (totalRotation !== pdfPage.getRotation().angle) {
      pdfPage.setRotation(PDFLib.degrees(totalRotation));
    }

    // WHY this runs HERE, before any drawing: applyPageSurgery's two rungs
    // must cut/append into the copied page's content stream before pdf-lib's
    // first draw call (drawRectangle/drawText/…) appends its OWN content
    // stream to the page — run it after and both rungs would have to contend
    // with content pdf-lib itself just wrote (see page-surgery.js's own WHY
    // for the full ordering argument). Image pages can't carry text targets
    // at all — guarded (not just inert) so a future image-page shape change
    // can't accidentally feed it here.
    const { skipCovers, skipDraw } = page.isFromImage
      ? { skipCovers: new Set(), skipDraw: new Set() }
      : await applyPageSurgery(pdfPage, PDFLib, fontkit, annotations);

    // MERGE WIDTH NORMALISATION (core/operations.js normalizePageWidths).
    // After a merge the model's display width is the FIRST page's width, but
    // copyPages above brought the source's own MediaBox across verbatim — so
    // this page is still its native size and has to be scaled to catch up.
    // Image pages need nothing: addImagePage already builds the box at
    // page.width/height, so they arrive normalised.
    //
    // WHY THE ORDER IS SURGERY → DRAW-AT-NATIVE-SCALE → SCALE, and not the
    // more obvious scale-then-draw. Two hard constraints, measured not assumed:
    //   1. Surgery must see the ORIGINAL content stream (page-surgery.js's own
    //      ordering WHY), and its targets are content-stream geometry, so it
    //      must run before anything rescales the page.
    //   2. pdf-lib's scaleContent wraps the page's content in `q <cm> … Q` and
    //      KEEPS WRITING INTO THAT SAME STREAM afterwards. Probed against the
    //      vendored build: a rectangle drawn AFTER scale(2,2) came back inside
    //      the wrapper, i.e. scaled a second time. So "scale, then draw the
    //      annotations" silently doubles every annotation's coordinates.
    // Drawing at native scale and scaling last is exact instead of merely
    // close: the scale is uniform and about the origin, and every term in
    // transformAnnotationCoords is linear in (x, y, wU, hU), so dividing the
    // annotation and the frame by the same factor and multiplying the finished
    // page back up lands on identical numbers.
    //
    // A page at factor 1 — every page of an unmerged document, and every page
    // that already matched the anchor — takes NO new call at all. That is
    // deliberate: the single-file case must stay on the path it has always
    // been on.
    const pageScale = page.baseWidth > 0 ? page.width / page.baseWidth : 1;
    const needsScale = !page.isFromImage && Number.isFinite(pageScale) && pageScale !== 1;

    if (annotations.length > 0) {
      // wU/hU: UNROTATED dims of the visible box (visibleBox above), x0/y0 its
      // origin — setRotation is metadata only, drawing happens in this frame.
      // See transformAnnotationCoords. Read BEFORE the scale below, so it is
      // the native frame the annotations are being expressed in.
      const { x0, y0, wU, hU } = visibleBox(pdfPage);
      // base + user, the SAME sum written to /Rotate above (core/page-rotation.js)
      // — not page.rotation alone. The page and its annotations must be
      // expressed in ONE frame: the reader applies /Rotate to the whole page,
      // annotations included, so a frame built from the user's rotation alone
      // transforms them for a page that is not the page being written. On a
      // source carrying an inherited /Rotate 90 that put a 40x20 bar drawn at
      // (10,10) into the file as 20x40 at x=812 — the far edge, turned. The
      // 2026-08-09 /Rotate fix corrected the line above and stopped here.
      const frame = { rotation: totalRotation, wU, hU, x0, y0 };
      // The source annotations under what the loop below will draw go into
      // the content first. After surgery (it must see the original stream),
      // before the loop (so the user's objects paint over them), before the
      // merge scale (so they scale with the page). NOT before Rung C's native
      // text: surgery already wrote that, so objects surgery handled
      // (skipCovers, skipDraw) are left out of the rects; flattening an
      // annotation there would still paint it over the new text, and only
      // cost it its interaction. See flattenPaintedAnnotations.
      if (!page.isFromImage) {
        const drawn = annotations
          .filter((a) => !skipCovers.has(a.id) && !skipDraw.has(a.id))
          .map((a) => (needsScale ? scaleAnnotationGeometry(a, 1 / pageScale) : a));
        flattenPaintedAnnotations(pdfPage, PDFLib, userObjectRects(drawn, frame));
      }
      // PAINT ORDER (core/annotation-order.js, founder ruling 2026-08-09):
      // Tip-Ex is a GROUND, not a layer. The SAME helper the screen uses, so
      // the two can't drift. It returns a COPY — `annotations` itself must
      // stay in creation order, because applyPageSurgery above was handed that
      // very array and pairs each Ganti cover to its replacement text by
      // walking it in creation order.
      for (const anno of orderedForPaint(annotations)) {
        if (skipCovers.has(anno.id)) continue; // surgery succeeded — true background shows through
        if (skipDraw.has(anno.id)) continue; // Rung C wrote this one natively — don't double-paint
        // WITNESS: a whiteout that reaches here is PAINTED OVER the page, so
        // whatever it hides is still in the file (the cut either never applied
        // or this is a plain Tip-Ex). The Unduh sheet's "covered" note counts
        // these; counting what is drawn cannot drift from what the file holds.
        if (anno.type === 'whiteout') {
          try { deps.onCoverDrawn?.(anno); } catch { /* reporting must never break the export */ }
        }
        const draw = ANNOTATION_DRAWERS[anno.type];
        if (!draw) {
          console.warn('[core/export] Unknown annotation type, skipping:', anno.type);
          continue;
        }
        await draw(pdfPage, needsScale ? scaleAnnotationGeometry(anno, 1 / pageScale) : anno, frame, env);
      }
    }

    if (needsScale) scalePageWithBoxes(pdfPage, pageScale);
  }

  return newDoc.save({ useObjectStreams: true, addDefaultPage: false });
}
