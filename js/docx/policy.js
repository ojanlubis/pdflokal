/*
 * PDFLokal — docx/policy.js  (DEVICE CLASS -> LIMITS; pure, no DOM at import time)
 * ============================================================================
 * Decides how big a PDF this device is allowed to convert to Word, and answers a
 * file that is too big with a LimitError (docx/stream.js) BEFORE any work is done
 * instead of a tab that dies. Two classes, because the browsers that matter split
 * in two: a phone (UA says mobile, or navigator.deviceMemory <= 4, or an iPad that
 * claims to be a Mac) and everything else.
 *
 * WHAT WAS MEASURED, AND WHAT WAS NOT (numbers: scripts/docx-shell-bench.mjs, a fresh
 * Chromium per run, the OS's own phys_footprint_peak of the renderer process, which holds
 * the page, the converter worker and pdf.js's worker; baseline ~14 MB; "delta" below is
 * peak minus that baseline; macOS arm64, 16 GB, other work running on the same machine).
 *
 * MEASURED, a Mac, converter in the worker, nothing capped (peak MB, pages):
 *   text-born, no pictures worth naming   n077  444 pp  335   n010  766 pp  586  (50 pp 255, 150 pp 313, 400 pp 467)
 *   pictures in a text document           n065   43 pp  112   n098   88 pp  216   n011  101 pp  292   n057  51 pp  341
 *   scans, 200 dpi, one JPEG per page     40 pp 578   200 pp 600                  (flat: the cost is the image, not the count)
 *   scans, 12 MP phone-camera pages       20 pp 659
 * MEASURED, same files, V8 old space capped at 32 to 64 MB on every isolate (what a small phone's
 * heap limit does to V8: it collects instead of growing): the converter still finishes, output identical:
 *   scans 200 dpi, 40 pp   152 MB     scans 12 MP, 20 pp   306 MB     text n010 400 pp (cap 48)  318 MB
 * So the ~600 MB the uncapped runs peak at is GARBAGE V8 had the room to leave lying around, and the
 * real working set is the 150 to 320 MB above. That is the number to compare a phone against, and
 * even that is dominated by ONE decoded picture at a time (a 12 MP page decodes to 48 MB of RGBA and is
 * held three times over while it is drawn, downscaled and encoded), not by how many pages there are.
 * MEASURED, the streaming writer against the old whole-model path (convertPdfToDocx): the same peak
 * to within 17% on every one of 7 corpus files and 3 scan files (n010: 586 vs 529 MB, n098: 216 vs 185). The model was never what
 * held the memory in a browser; the 904 MB of the spike was node, with pdf.js in-process and V8's default
 * heap. What streaming does buy is that the memory no longer GROWS with the output (camera scans, 100 pp:
 * the whole-model path 1,004 MB, see docx-shell-bench in the shell lane's report) and that the zip leaves
 * the worker as it is made. Do not read the table as "streaming halves memory": it does not.
 * MEASURED, the same Mac with the renderer process duty-cycled SIGSTOP/SIGCONT (scripts/docx-shell-bench.mjs --throttle 4;
 * a spin loop calibrates at 4.7x main thread and 5.5x worker, but real runs land between 1.5x and 9x of the unthrottled time
 * (the cause is NOT established; INFERRED: the stop/run cycle interacts with I/O waits and with the browser process, which is not
 * stopped. Treat it as a noisy instrument, not a 4x ruler, and read the 1.5x to 2x rows below as under-throttled). Worker path, ms per page
 * unthrottled -> throttled: text n077 5 -> 33, n010 13 -> 109, pictures n098 17 -> 32, n011 22 -> 40, n065 12 -> 110.
 * n010 (766 pp) takes 10 s unthrottled and 84 s throttled; peak memory does not move with the throttle (549 vs 586 MB). So 400
 * text pages on a slow phone is on the order of 40 s, not minutes, and the page cap is a time guard more than a memory one.
 * MEASURED and REJECTED: pdf.cleanup() every N pages cut a 400-page text run by 24% (467 to 356 MB) and
 * the output changed (pdf.js forgets its image ids, so a picture used on many pages is encoded and
 * stored again: n065 went from 162 to 198 zip entries). Not shipped.
 *
 * INFERRED, not measured (no phone was available): where a real phone's limit is. A 3 to 4 GB Android
 * renderer is commonly killed somewhere between 400 and 700 MB and an iPhone tab above ~1 GB; the phone
 * numbers below are chosen so that the measured working set stays under ~350 MB, and the pixel risk
 * (one enormous picture) is NOT covered by any page or byte cap: that guard belongs in docx/images.js.
 *
 * WHAT EACH NUMBER IS FOR
 *   maxInputBytes   the PDF is held about three times while it is open (the page, the worker, pdf.js's own
 *                   worker), so 50 MB is ~150 MB of floor on a phone before the first page is read. The largest
 *                   file in the 104-file corpus is 17.8 MB; a 20-page camera-scan PDF is 28 MB.
 *   maxPages        time, not memory: a text page costs 5 to 25 ms on a desktop (measured, 120 to 766 pages)
 *                   and a 12 MP scan page ~0.9 s; a phone is slower by a multiple (see the throttled rows in the
 *                   report). 400 text pages is ~320 MB working set (measured under a 48 MB heap cap).
 *   maxOutputBytes  the .docx is held by the page as Blob parts and then has to be saved and opened: the
 *                   largest .docx the corpus produces is 13.6 MB (n010, 766 pp, MEASURED); 200 synthetic 200 dpi
 *                   scan pages come to 43 MB and 100 camera-scan pages to 23 MB.
 *   imageCacheBytes encoded pictures kept so a logo repeated on every page is encoded once.
 *   spoolBytes      media held back so a SMALL document keeps the canonical zip order; past this they are
 *                   written out as they appear (docx/writer.js).
 * overPages is 'refuse': silently converting the first 400 pages of a 700-page file and handing it over as
 * if it were the document is worse than saying no. The UI can pass { overPages: 'truncate' } if it offers it.
 */
export const CLASSES = {
  phone: {
    maxInputBytes: 50 * 1024 * 1024,
    maxPages: 400,
    maxOutputBytes: 100 * 1024 * 1024,
    imageCacheBytes: 12 * 1024 * 1024,
    spoolBytes: 8 * 1024 * 1024,
    overPages: 'refuse',
  },
  desktop: {
    maxInputBytes: 250 * 1024 * 1024,
    maxPages: 1500,
    maxOutputBytes: 500 * 1024 * 1024,
    imageCacheBytes: 48 * 1024 * 1024,
    spoolBytes: 16 * 1024 * 1024,
    overPages: 'refuse',
  },
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

// o = { force?: 'phone' | 'desktop', nav?: a navigator-shaped object (tests) }
export function assessDevice(o = {}) {
  if (o.force) return { class: o.force, ...CLASSES[o.force] };
  const nav = o.nav || (typeof navigator !== 'undefined' ? navigator : {});
  const ua = nav.userAgent || '';
  const mem = nav.deviceMemory; // Chromium only; capped at 8; absent on Safari and Firefox
  // iPadOS Safari sends a Macintosh UA: a Mac with a touch screen is an iPad
  const ipad = /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
  const cls = MOBILE_UA.test(ua) || ipad || (mem && mem <= 4) ? 'phone' : 'desktop';
  return { class: cls, deviceMemoryGB: mem || null, cores: nav.hardwareConcurrency || null, ...CLASSES[cls] };
}

export function limitsFor(device) {
  const { maxInputBytes, maxPages, maxOutputBytes, imageCacheBytes, spoolBytes, overPages } = device;
  return { maxInputBytes, maxPages, maxOutputBytes, imageCacheBytes, spoolBytes, overPages };
}
