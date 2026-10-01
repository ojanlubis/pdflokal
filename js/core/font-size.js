/*
 * PDFLokal — core/font-size.js  (text size: parse what the user typed)
 * ============================================================================
 * Headless and pure. The format bar's size field is a typed number (plus
 * presets), so this is the one place that decides what a string becomes.
 *
 * WHY: founder 2026-10-01 — the old <select> bottomed out at 10 pt and a
 * friend could not set smaller text or type a size. Range 1..120 matches the
 * ceiling the resize gesture (render/interaction.js) already enforced; the
 * floor dropped from 6 to 1 so the field and the gesture agree.
 */

export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 120;
export const FONT_SIZE_PRESETS = [6, 8, 10, 12, 14, 18, 24, 32, 48, 64];

/**
 * parseFontSize('7,5', 18) -> 7.5. Comma or dot decimals (Indonesian keyboards
 * type a comma). Out of range clamps into 1..120; anything that is not a plain
 * number (empty, 'abc', '1e3', '12px') returns `current` untouched, so garbage
 * can never put NaN into an annotation. Result is rounded to 1 decimal.
 */
export function parseFontSize(str, current) {
  const s = String(str ?? '').trim().replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return current;
  const n = Number(s);
  if (!Number.isFinite(n)) return current;
  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
  return Math.round(clamped * 10) / 10;
}

/** Display text for a stored size: 18 -> '18', 7.395 -> '7.4'. Display only; never written back. */
export function formatFontSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 10) / 10);
}
