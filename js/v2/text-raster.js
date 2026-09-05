/*
 * PDFLokal — v2/text-raster.js  (PAINT A TEXT ANNOTATION THE WAY THE SCREEN DID)
 * ============================================================================
 * The browser half of core/export.js's glyph fallback. When a text annotation
 * carries a character the chosen PDF font cannot paint — ✓ → ★ ☑ in Helvetica
 * (WinAnsi), an emoji or CJK in any font we ship — the export used to THROW
 * and the user left with nothing: measured 2026-08-23..09-05, six sessions hit
 * `export/unsupported`, five of them exported zero files, one retried 24
 * times. The screen had painted the character perfectly the whole time,
 * because the screen uses the browser's own font stack.
 *
 * So this module asks the browser to paint that annotation onto a canvas with
 * EXACTLY the font string the overlay used (page-view.js's textFontCss —
 * one source of truth, so the raster and the screen cannot disagree), and
 * core/export.js embeds the PNG where the text would have gone. Only the
 * offending annotation becomes an image; every other one stays real text.
 *
 * Geometry contract with core/export.js's drawText: width/height are returned
 * in PAGE-SPACE POINTS (page px == points at scale 1, the same convention the
 * overlay positions with), lines are 1.2em apart and the first baseline sits
 * 0.9em below the block top — the same TEXT_LINE_HEIGHT / TEXT_BASELINE_RATIO
 * export.js draws real text with, so a rasterised line lands on the same
 * baseline its neighbours do.
 *
 * Headless callers (Node tests) never see this file: core/export.js only
 * takes the raster branch when the adapter injected it, and throws exactly as
 * before when it did not.
 */
import { textFontCss } from '../render/page-view.js';

// Oversample so the raster stays crisp when a viewer zooms. Capped so a huge
// annotation cannot ask for a canvas the GPU refuses (mobile Safari caps a
// canvas side around 4096px and returns a blank, not an error).
const RASTER_SCALE = 4;
const MAX_CANVAS_SIDE = 4096;
const LINE_HEIGHT = 1.2;      // = export.js TEXT_LINE_HEIGHT
const BASELINE_RATIO = 0.9;   // = export.js TEXT_BASELINE_RATIO

/**
 * @param {object} anno a core text annotation (text, fontFamily, fontSize, bold, italic, color)
 * @returns {Promise<{png: Uint8Array, width: number, height: number}|null>}
 *   null when nothing can be painted (empty text, no canvas) — the caller then
 *   falls through to its ordinary path, which is the honest failure.
 */
export async function rasterizeTextAnno(anno) {
  if (typeof document === 'undefined') return null;
  const text = String(anno?.text ?? '');
  const lines = text.split('\n');
  const size = Number(anno?.fontSize) > 0 ? Number(anno.fontSize) : 16;
  const font = textFontCss({ ...anno, fontSize: size });

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  measure.font = font;
  const widest = Math.max(...lines.map((l) => measure.measureText(l).width), 0);
  // Some colour-emoji glyphs report an advance narrower than their bitmap;
  // pad a quarter-em so the last glyph's right edge is never clipped.
  const width = Math.ceil(widest + size * 0.25);
  const height = Math.ceil(lines.length * size * LINE_HEIGHT);
  if (width <= 0 || height <= 0 || !text.trim()) return null;

  const scale = Math.min(RASTER_SCALE, MAX_CANVAS_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.fillStyle = anno?.color || '#000000';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, size * BASELINE_RATIO + i * size * LINE_HEIGHT);
  });

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
}
