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

// ---- fonts ------------------------------------------------------------------

// Key format: [family] → { [bold][italic] } → pdf-lib font name.
// Helvetica/Times/Courier are pdf-lib standard fonts (no bytes embedded);
// Montserrat/Carlito are self-hosted files embedded via fontkit.
const FONT_NAME_MAP = {
  'Helvetica':   { '00': 'Helvetica', '10': 'HelveticaBold', '01': 'HelveticaOblique', '11': 'HelveticaBoldOblique' },
  'Times-Roman': { '00': 'TimesRoman', '10': 'TimesRomanBold', '01': 'TimesRomanItalic', '11': 'TimesRomanBoldItalic' },
  'Courier':     { '00': 'Courier', '10': 'CourierBold', '01': 'CourierOblique', '11': 'CourierBoldOblique' },
  'Montserrat':  { '00': 'Montserrat', '10': 'Montserrat-Bold', '01': 'Montserrat-Italic', '11': 'Montserrat-BoldItalic' },
  'Carlito':     { '00': 'Carlito', '10': 'Carlito-Bold', '01': 'Carlito-Italic', '11': 'Carlito-BoldItalic' },
  // Metric clones (font-fidelity tier 1, core/font-decide.js): routed by
  // /BaseFont for substitution AND offered in the font dropdown as authoring
  // choices (founder ruling 2026-07-20 evening; spec §3).
  'Arimo':       { '00': 'Arimo', '10': 'Arimo-Bold', '01': 'Arimo-Italic', '11': 'Arimo-BoldItalic' },
  'Tinos':       { '00': 'Tinos', '10': 'Tinos-Bold', '01': 'Tinos-Italic', '11': 'Tinos-BoldItalic' },
  'Cousine':     { '00': 'Cousine', '10': 'Cousine-Bold', '01': 'Cousine-Italic', '11': 'Cousine-BoldItalic' },
  'Caladea':     { '00': 'Caladea', '10': 'Caladea-Bold', '01': 'Caladea-Italic', '11': 'Caladea-BoldItalic' },
};

const CUSTOM_FONT_URLS = {
  'Montserrat': 'fonts/montserrat-regular.woff2',
  'Montserrat-Bold': 'fonts/montserrat-bold.woff2',
  'Montserrat-Italic': 'fonts/montserrat-italic.woff2',
  'Montserrat-BoldItalic': 'fonts/montserrat-bolditalic.woff2',
  'Carlito': 'fonts/carlito-regular.woff2',
  'Carlito-Bold': 'fonts/carlito-bold.woff2',
  'Carlito-Italic': 'fonts/carlito-italic.woff2',
  'Carlito-BoldItalic': 'fonts/carlito-bolditalic.woff2',
  'Arimo': 'fonts/arimo-regular.woff2',
  'Arimo-Bold': 'fonts/arimo-bold.woff2',
  'Arimo-Italic': 'fonts/arimo-italic.woff2',
  'Arimo-BoldItalic': 'fonts/arimo-bolditalic.woff2',
  'Tinos': 'fonts/tinos-regular.woff2',
  'Tinos-Bold': 'fonts/tinos-bold.woff2',
  'Tinos-Italic': 'fonts/tinos-italic.woff2',
  'Tinos-BoldItalic': 'fonts/tinos-bolditalic.woff2',
  'Cousine': 'fonts/cousine-regular.woff2',
  'Cousine-Bold': 'fonts/cousine-bold.woff2',
  'Cousine-Italic': 'fonts/cousine-italic.woff2',
  'Cousine-BoldItalic': 'fonts/cousine-bolditalic.woff2',
  'Caladea': 'fonts/caladea-regular.woff2',
  'Caladea-Bold': 'fonts/caladea-bold.woff2',
  'Caladea-Italic': 'fonts/caladea-italic.woff2',
  'Caladea-BoldItalic': 'fonts/caladea-bolditalic.woff2',
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
    console.warn('[core/export] fontkit/fetch unavailable — Helvetica fallback for', fontName);
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

function drawWhiteout(pdfPage, anno, frame, env) {
  const r = whiteoutCornerAndDims(frame.rotation, anno, frame.wU, frame.hU);
  // Color-matched Tip-Ex: anno.color is sampled from the page background at
  // draw time (app layer). White stays the default for plain documents.
  const color = anno.color ? parseHexColor(env.PDFLib, anno.color) : env.PDFLib.rgb(1, 1, 1);
  pdfPage.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color });
}

async function drawText(pdfPage, anno, frame, env) {
  const font = await env.getFont(anno.fontFamily, anno.bold, anno.italic);
  const color = parseHexColor(env.PDFLib, anno.color);
  const rotate = env.PDFLib.degrees(frame.rotation);
  const size = anno.fontSize || 16;
  const lines = String(anno.text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const yV = anno.y + size * TEXT_BASELINE_RATIO + i * size * TEXT_LINE_HEIGHT;
    const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
    pdfPage.drawText(lines[i], { x, y, size, font, color, rotate });
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
  const size = anno.fontSize || 48;
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
  pdfPage.drawText(anno.text || '', {
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
  const size = anno.fontSize || 12;
  const yV = anno.y + size * TEXT_BASELINE_RATIO;
  const { x, y } = transformAnnotationCoords(frame.rotation, anno.x, yV, frame.wU, frame.hU);
  pdfPage.drawText(anno.text || '', {
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

  const env = { PDFLib, fontkit, newDoc, fontCache: {}, imageCache: new Map() };
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
    if (page.rotation) pdfPage.setRotation(PDFLib.degrees(page.rotation));

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
      : applyPageSurgery(pdfPage, PDFLib, fontkit, annotations);

    if (annotations.length === 0) continue;
    // wU/hU: UNROTATED page dims (MediaBox) — setRotation is metadata only,
    // drawing happens in this frame. See transformAnnotationCoords.
    const { width: wU, height: hU } = pdfPage.getSize();
    const frame = { rotation: page.rotation || 0, wU, hU };
    for (const anno of annotations) {
      if (skipCovers.has(anno.id)) continue; // surgery succeeded — true background shows through
      if (skipDraw.has(anno.id)) continue; // Rung C wrote this one natively — don't double-paint
      const draw = ANNOTATION_DRAWERS[anno.type];
      if (!draw) {
        console.warn('[core/export] Unknown annotation type, skipping:', anno.type);
        continue;
      }
      await draw(pdfPage, anno, frame, env);
    }
  }

  return newDoc.save({ useObjectStreams: true, addDefaultPage: false });
}
