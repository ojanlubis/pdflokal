/*
 * THE ZOOM RANGE, AS ONE PURE MODULE (extracted from v2/app.js so a node test
 * can hold the numbers; app.js is DOM-at-import and cannot be loaded headless).
 *
 * WHY THE FLOOR FOLLOWS THE DOCUMENT: an image page's point size IS its pixel
 * size (core/import.js), so a 3024px phone photo is a 3024pt-wide page. Fitted
 * to a 412px phone that is a zoom of 0.131 -- but the floor was a flat 0.3, so
 * the photo opened at 0.3 (907px, over twice the screen) and zoom-out was dead:
 * the user could never see the whole page. The floor is therefore the smaller
 * of the usual 0.3 and the zoom that fits the document's widest page. An A4
 * (fit 0.666 on a phone) keeps exactly 0.3.
 */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;

// 48px a side on desktop: a vertical scrollbar (~15px) appears the moment the
// fitted page is taller than the window, and filling to the last pixel would
// hand every desktop user a horizontal scrollbar on open.
export const OPENING_GUTTER_DESKTOP = 96;
export const OPENING_GUTTER_TOUCH = 16;

function fitZoom({ viewport, pageWidth, desktop }) {
  const gutter = desktop ? OPENING_GUTTER_DESKTOP : OPENING_GUTTER_TOUCH;
  return (viewport - gutter) / pageWidth;
}

// The lowest zoom the view may reach for a document whose widest page is
// `widestPageWidth` (page-space px, rotation already applied).
export function zoomFloor({ viewport, widestPageWidth, desktop }) {
  if (!(widestPageWidth > 0)) return ZOOM_MIN;
  const fit = fitZoom({ viewport, pageWidth: widestPageWidth, desktop });
  // A viewport narrower than the gutter gives a non-positive fit; a floor of
  // zero (or less) would let the view collapse to nothing.
  return fit > 0 ? Math.min(ZOOM_MIN, fit) : ZOOM_MIN;
}

// The zoom a freshly opened document lands on.
export function openingZoom({ viewport, pageWidth, desktop, widestPageWidth = pageWidth }) {
  if (!(pageWidth > 0)) return 1;
  const fit = fitZoom({ viewport, pageWidth, desktop });
  const floor = zoomFloor({ viewport, widestPageWidth, desktop });
  return Math.max(floor, Math.min(fit, desktop ? ZOOM_MAX : 1));
}

// Clamp a requested zoom to [floor, ZOOM_MAX]. Never RAISES a view that already
// sits below the floor (a wide page deleted while zoomed out): zoom-out there
// is a no-op, not a jump upward.
export function clampZoom(next, { floor, current }) {
  return Math.min(ZOOM_MAX, Math.max(Math.min(floor, current), next));
}

// The zoom after a load has put its pages on screen.
//
// WHY a load can need a refit that is not the first one: merging normalises every
// page to the first PDF's width (operations.js normalizePageWidths). A phone photo
// opened first sits at its own fit (0.131 for a 3024pt page); add an A4 and that
// photo page shrinks to 595pt while the zoom stays 0.131, so every page renders
// ~78px wide, and clampZoom's never-raise rule makes zoom-out a no-op. The view
// followed pages that no longer exist at that size.
// `existingRescaled` is "a page that was already on screen changed width": new
// pages scaled to the document leave the user's chosen zoom alone (a PDF first,
// then a photo added). The refit lives here and not in clampZoom, whose
// never-raise rule is deliberate.
export function zoomAfterLoad({ firstLoad, existingRescaled, current, viewport, desktop, firstPageWidth, widestPageWidth }) {
  if (!firstLoad && !existingRescaled) return current;
  return openingZoom({ viewport, pageWidth: firstPageWidth, desktop, widestPageWidth });
}
