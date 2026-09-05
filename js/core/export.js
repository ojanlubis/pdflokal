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
import { CLONE_FONT_VARIANTS, CLONE_FONT_URLS } from './clone-fonts.js';
import { toStandardFontSafe, drawTextSafe, unencodableInStandardFont } from './text-encode.js';
import { totalPageRotation } from './page-rotation.js';
import { orderedForPaint } from './annotation-order.js';

// ---- fonts ------------------------------------------------------------------

// Key format: [family] → { [bold][italic] } → pdf-lib font name.
// Helvetica/Times/Courier are pdf-lib standard fonts (no bytes embedded);
// Montserrat is a self-hosted file embedded via fontkit. The five
// Croscore/crosextra clone families (Arimo/Tinos/Cousine/Carlito/Caladea —
// font-fidelity tier 1, core/font-decide.js) are spread in from
// clone-fonts.js: routed by /BaseFont for substitution AND offered in the
// font dropdown as authoring choices (founder ruling 2026-07-20 evening;
// spec-font-fidelity-engine.md §3) — core/stamp.js's rung-2 clone ladder
// needs the EXACT same weight-file mapping to fetch the same woff2 this
// module would, so it's factored into one shared source rather than kept as
// two copies.
const FONT_NAME_MAP = {
  'Helvetica':   { '00': 'Helvetica', '10': 'HelveticaBold', '01': 'HelveticaOblique', '11': 'HelveticaBoldOblique' },
  'Times-Roman': { '00': 'TimesRoman', '10': 'TimesRomanBold', '01': 'TimesRomanItalic', '11': 'TimesRomanBoldItalic' },
  'Courier':     { '00': 'Courier', '10': 'CourierBold', '01': 'CourierOblique', '11': 'CourierBoldOblique' },
  'Montserrat':  { '00': 'Montserrat', '10': 'Montserrat-Bold', '01': 'Montserrat-Italic', '11': 'Montserrat-BoldItalic' },
  ...CLONE_FONT_VARIANTS,
};

const CUSTOM_FONT_URLS = {
  'Montserrat': 'fonts/montserrat-regular.woff2',
  'Montserrat-Bold': 'fonts/montserrat-bold.woff2',
  'Montserrat-Italic': 'fonts/montserrat-italic.woff2',
  'Montserrat-BoldItalic': 'fonts/montserrat-bolditalic.woff2',
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
// page dims from page.getSize() (the MediaBox).
function transformAnnotationCoords(rotation, xV, yV, wU, hU) {
  switch (rotation) {
    case 90:  return { x: yV,      y: xV };
    case 180: return { x: wU - xV, y: yV };
    case 270: return { x: wU - yV, y: hU - xV };
    default:  return { x: xV,      y: hU - yV };
  }
}

// Whiteout: pdf-lib drawRectangle is axis-aligned in the unrotated page frame.
// For 90°/270° page rotations the view-horizontal direction maps to
// PDF-vertical, so width and height swap. The anchor is the corner of the
// view-space rect that becomes the bottom-left of the unrotated PDF rect
// after the rotation transform (verify each case by hand against
// transformAnnotationCoords).
function whiteoutCornerAndDims(rotation, anno, wU, hU) {
  const { x: xC, y: yC, width: wC, height: hC } = anno;
  switch (rotation) {
    case 90: {  // view TL → PDF bottom-left
      const { x, y } = transformAnnotationCoords(90, xC, yC, wU, hU);
      return { x, y, width: hC, height: wC };
    }
    case 180: {  // view TR → PDF bottom-left
      const { x, y } = transformAnnotationCoords(180, xC + wC, yC, wU, hU);
      return { x, y, width: wC, height: hC };
    }
    case 270: {  // view BR → PDF bottom-left
      const { x, y } = transformAnnotationCoords(270, xC + wC, yC + hC, wU, hU);
      return { x, y, width: hC, height: wC };
    }
    default: {  // rotation 0: view BL → PDF bottom-left
      const { x, y } = transformAnnotationCoords(0, xC, yC + hC, wU, hU);
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

function drawWhiteout(pdfPage, anno, frame, env) {
  const r = whiteoutCornerAndDims(frame.rotation, anno, frame.wU, frame.hU);
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
  // Anchor at the view-space BOTTOM-LEFT of the block, exactly like drawSignature.
  const yV = anno.y + raster.height;
  const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
  pdfPage.drawImage(img, {
    x, y, width: raster.width, height: raster.height, rotate: env.PDFLib.degrees(frame.rotation),
  });
  return true;
}

async function drawText(pdfPage, anno, frame, env) {
  const font = await env.getFont(anno.fontFamily, anno.bold, anno.italic);
  const color = parseHexColor(env.PDFLib, anno.color);
  const rotate = env.PDFLib.degrees(frame.rotation);
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
    const yV = anno.y + size * TEXT_BASELINE_RATIO + i * size * TEXT_LINE_HEIGHT;
    const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
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
  // Anchor pdf-lib drawImage at the view-space BOTTOM-LEFT of the image:
  // transformed through the page rotation, this lands the visible image
  // exactly where the user placed it in the rotated view.
  const yV = anno.y + height;
  const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
  pdfPage.drawImage(img, { x, y, width, height, rotate: env.PDFLib.degrees(frame.rotation) });
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
  const { x: cx, y: cy } = transformAnnotationCoords(frame.rotation, anno.x, anno.y, frame.wU, frame.hU);
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
  const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
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

function sniffImageFormat(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

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

// The geometric fields every drawer above reads, scaled by `k`. Used to express
// annotation coordinates — which live in the page's NORMALISED display frame —
// back in the source page's NATIVE frame, so they can be drawn alongside the
// original content and then scaled up with it in one uniform move (see the
// ordering argument in buildPdfBytes).
//
// ⚠️ Deliberately NOT applied to `replaceBox`/`replaceTargets`. Those are
// surgery inputs, and surgery reads content-stream geometry, which is native
// already — applyPageSurgery runs on the untouched annotation list, before any
// of this. Scaling them here would send a doubly-transformed target into
// text-walk.js and silently lose the match.
//
// Undefined fields stay undefined: drawSignature derives a missing `height`
// from the embedded image's own ratio, and multiplying `undefined` would turn
// that into NaN and drop the signature off the page.
function scaleAnnotationGeometry(anno, k) {
  const out = { ...anno };
  for (const key of ['x', 'y', 'width', 'height', 'fontSize']) {
    if (Number.isFinite(out[key])) out[key] *= k;
  }
  return out;
}

// ---- the adapter ---------------------------------------------------------------

// Build final PDF bytes for a core Doc. `deps` injects the vendor libs so the
// module stays vendor-import-free (browser: omit deps, globals are picked up;
// Node: pass { PDFLib, fontkit } explicitly).
export async function buildPdfBytes(doc, deps = {}) {
  const PDFLib = deps.PDFLib || globalThis.PDFLib;
  const fontkit = deps.fontkit || globalThis.fontkit;
  if (!PDFLib) throw new Error('buildPdfBytes: PDFLib is required (inject via deps or load the vendor script)');

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

  for (const { page, source, annotations } of buildExportPlan(doc)) {
    if (!source) throw new Error(`buildPdfBytes: page ${page.id} references missing source ${page.sourceId}`);

    let pdfPage;
    if (page.isFromImage) {
      pdfPage = await addImagePage(env, page, source);
    } else {
      const srcDoc = await getSrcDoc(source);
      const [copied] = await newDoc.copyPages(srcDoc, [page.sourcePageNum]);
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
      // wU/hU: UNROTATED page dims (MediaBox) — setRotation is metadata only,
      // drawing happens in this frame. See transformAnnotationCoords. Read
      // BEFORE the scale below, so it is the native frame the annotations are
      // being expressed in.
      const { width: wU, height: hU } = pdfPage.getSize();
      // base + user, the SAME sum written to /Rotate above (core/page-rotation.js)
      // — not page.rotation alone. The page and its annotations must be
      // expressed in ONE frame: the reader applies /Rotate to the whole page,
      // annotations included, so a frame built from the user's rotation alone
      // transforms them for a page that is not the page being written. On a
      // source carrying an inherited /Rotate 90 that put a 40x20 bar drawn at
      // (10,10) into the file as 20x40 at x=812 — the far edge, turned. The
      // 2026-08-09 /Rotate fix corrected the line above and stopped here.
      const frame = { rotation: totalRotation, wU, hU };
      // PAINT ORDER (core/annotation-order.js, founder ruling 2026-08-09):
      // Tip-Ex is a GROUND, not a layer. The SAME helper the screen uses, so
      // the two can't drift. It returns a COPY — `annotations` itself must
      // stay in creation order, because applyPageSurgery above was handed that
      // very array and pairs each Ganti cover to its replacement text by
      // walking it in creation order.
      for (const anno of orderedForPaint(annotations)) {
        if (skipCovers.has(anno.id)) continue; // surgery succeeded — true background shows through
        if (skipDraw.has(anno.id)) continue; // Rung C wrote this one natively — don't double-paint
        const draw = ANNOTATION_DRAWERS[anno.type];
        if (!draw) {
          console.warn('[core/export] Unknown annotation type, skipping:', anno.type);
          continue;
        }
        await draw(pdfPage, needsScale ? scaleAnnotationGeometry(anno, 1 / pageScale) : anno, frame, env);
      }
    }

    if (needsScale) pdfPage.scale(pageScale, pageScale);
  }

  return newDoc.save({ useObjectStreams: true, addDefaultPage: false });
}
