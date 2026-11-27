/*
 * PDFLokal — v2/user-fonts.js  (BROWSER EDGE: fonts the user brings)
 * ============================================================================
 * The rules live in core/user-fonts.js; this file only keeps them in this
 * browser. A font file is read here, kept in IndexedDB ('pdflokal-fonts', its
 * own database, so it never touches the saved-documents schema), registered
 * as a FontFace for the screen, and handed to core/export.js at download
 * (js/v2/pdf-builder.js). Nothing is uploaded, ever: same promise as the PDFs.
 *
 * Storage can be refused (private window, Safari quota): then the font still
 * works for this visit, held in memory, and is simply not there next time.
 */
import { inspectFontBytes, userFontKey, userFontCss } from '../core/user-fonts.js';
import { ensureFontkit } from '../core/vendor.js';

const DB_NAME = 'pdflokal-fonts';
const STORE = 'fonts';
// A font bigger than this is almost certainly a CJK super-family; it would
// make every download carry megabytes. Refused with its own reason.
export const MAX_FONT_BYTES = 15 * 1024 * 1024;

const fonts = new Map(); // key -> { key, name, bytes }
const faces = new Map(); // key -> FontFace, so a font is registered once
let loaded = null;

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function openDb() {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) { reject(new Error('indexedDB unavailable')); return; }
    let req;
    try { req = idb.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function register(entry) {
  if (faces.has(entry.key) || typeof FontFace !== 'function') return;
  const face = new FontFace(userFontCss(entry.key), entry.bytes);
  faces.set(entry.key, face);
  try { await face.load(); document.fonts.add(face); } catch { faces.delete(entry.key); }
}

// Every font this browser kept, registered for the screen. Idempotent.
export function loadUserFonts() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const db = await openDb();
      const all = await wrap(db.transaction(STORE).objectStore(STORE).getAll());
      for (const e of all) {
        if (!e?.key || !(e.bytes instanceof ArrayBuffer || ArrayBuffer.isView(e.bytes))) continue;
        const entry = { key: e.key, name: e.name || 'Font', bytes: new Uint8Array(e.bytes) };
        fonts.set(entry.key, entry);
        await register(entry);
      }
    } catch { /* storage refused: this visit starts with no kept fonts */ }
    return listUserFonts();
  })();
  return loaded;
}

export function listUserFonts() {
  return [...fonts.values()].map(({ key, name }) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// core/export.js asks for a font's bytes at download (pdf-builder.js).
export async function userFontBytes(key) {
  if (!fonts.has(key)) await loadUserFonts();
  return fonts.get(key)?.bytes || null;
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A File the user picked -> { ok: true, key, name } or { ok: false, reason }.
// reason: core/user-fonts.js inspectFontBytes's, or 'too-big'.
export async function addUserFont(file) {
  if (!file) return { ok: false, reason: 'not-font' };
  if (file.size > MAX_FONT_BYTES) return { ok: false, reason: 'too-big' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fontkit = await ensureFontkit();
  const seen = inspectFontBytes(bytes, fontkit);
  if (!seen.ok) return seen;
  const key = userFontKey(await sha256Hex(bytes));
  const entry = { key, name: seen.family, bytes };
  fonts.set(key, entry);
  await register(entry);
  try {
    const db = await openDb();
    await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, name: entry.name, bytes: bytes.buffer }));
  } catch { /* kept for this visit only, see the header */ }
  return { ok: true, key, name: entry.name };
}

// The picker. A hidden input made here, once, so index.html needs no markup
// and the replay recorder's file-input block (index.html) covers it anyway.
let input = null;
export function pickFontFile() {
  return new Promise((resolve) => {
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ttf,.otf,font/ttf,font/otf';
      input.hidden = true;
      input.id = 'user-font-file';
      document.body.appendChild(input);
    }
    input.value = '';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
