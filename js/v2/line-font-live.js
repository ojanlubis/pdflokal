/*
 * PDFLokal — v2/line-font-live.js  (the editor half of ONE font per line)
 * ============================================================================
 * core/line-font.js decides which ONE font can write a whole line. This file
 * makes the Ganti Teks editor live by that decision while the user types:
 *
 *   - every candidate font is loaded into the browser from the SAME bytes the
 *     stamp will embed — the doc's own program (js/v2/app.js's loadDocFont) or
 *     the bundled TTF in fonts/ttf/ (never the CSS woff2);
 *   - on every input the line is re-decided and the editor renders exactly
 *     that one face (render/page-view.js applyTextFont: one family, no stack,
 *     no kerning, no synthesis) — so no letter ever paints in a second font;
 *   - a character no candidate can write is REFUSED at input with a short
 *     note (his answer 2, seat decisions.md 2026-10-01 malam, last). When
 *     every char is writable by SOME font but no single font takes them all,
 *     the keystroke that broke the line is undone.
 *
 * The founder's principle this enforces: what the user sees while typing is
 * what the file will contain.
 */

import { acceptLineInput, decideLineFont, faceCssFamily, storedDecision } from '../core/line-font.js';
import { CLONE_FONT_URLS, isSfntFontProgram } from '../core/clone-fonts.js';
import { applyTextFont } from '../render/page-view.js';

// TODO(copy): placeholder until Fauzan writes the note (EXCLUDE 2 — client
// copy is his). One home, so his wording lands in exactly one place.
export function refusalNote(ch) {
  return `Huruf "${ch}" belum bisa ditulis di PDF ini.`;
}

// ---- bundled faces, loaded from the bytes the stamp embeds ---------------------

const FACE_FETCH_TIMEOUT_MS = 10000; // same guard as core/stamp.js's clone fetch
const faceCache = new Map(); // pdf-lib font name -> Promise<{face, css, parsed}|null>

// Load one bundled face ('Carlito-Bold') as BOTH a parsed fontkit program (what
// decideLineFont judges coverage on) and a FontFace (what the editor paints
// with), from one fetch of the TTF core/stamp.js embeds. Registered at the
// default 400/normal descriptors on purpose: every decided element asks for
// 400/normal (render/page-view.js textFontCss), and a family holding exactly
// one face can then never be synthesised bolder or slanted. null on any
// decline — a face that fails to load is simply not offered as a candidate.
export function loadFaceFont(face, fontkit) {
  const url = CLONE_FONT_URLS[face];
  if (!url || !fontkit || typeof FontFace !== 'function') return Promise.resolve(null);
  if (!faceCache.has(face)) {
    faceCache.set(face, (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FACE_FETCH_TIMEOUT_MS);
      let bytes;
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        bytes = new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
      if (!isSfntFontProgram(bytes)) return null;
      const parsed = fontkit.create(bytes);
      const css = faceCssFamily(face);
      const ff = new FontFace(css, bytes);
      await ff.load();
      document.fonts.add(ff);
      return { face, css, parsed };
    })().catch(() => {
      faceCache.delete(face); // a transient failure must not poison later taps
      return null;
    }));
  }
  return faceCache.get(face);
}

// ---- caret-preserving text replacement -------------------------------------------

function caretOffset(ed) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!ed.contains(r.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(ed);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

// Replace the editor's text and put the caret back where the user's typing
// was. Refusal only ever REMOVES characters at or before the caret (the key
// just pressed, or the unwritable chars of a paste the caret sits after), so
// shifting the offset left by the length difference lands it right.
function replaceText(ed, before, after) {
  const offset = caretOffset(ed);
  ed.textContent = after;
  const node = ed.firstChild;
  if (!node) return;
  const at = offset == null
    ? after.length
    : Math.max(0, Math.min(after.length, offset - (before.length - after.length)));
  try {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(node, at);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  } catch { /* caret placement is best-effort; the text itself is already right */ }
}

// The identity of the face a decision paints with — a flip is a change of it.
function faceId(decision) {
  return decision ? `${decision.path}:${decision.key ?? ''}:${decision.face ?? ''}` : '';
}

// ---- the live controller ------------------------------------------------------------
//
// Attach to an open Ganti editor once its candidate fonts have loaded.
// `draft` is the SAME object openTextEditor holds; its `fontDecision` is kept
// current so the commit path and every restyle read the decision, never a
// stack. `lineKey` is the line's own /Font resource (rides the stored decision
// so a re-edit can re-load the doc font without re-deriving the line).
// Returns { decideNow(text), flips } or null when the editor is already gone.
export function startLineFont({ draft, candidates, lineKey = null, onRefuse }) {
  const ed = draft && draft.editorEl;
  if (!ed || !ed.isConnected) return null;
  const live = candidates.filter(Boolean);
  const stored = (d) => {
    const s = storedDecision(d);
    return s && lineKey != null ? { ...s, lineKey } : s;
  };

  const state = { accepted: ed.textContent, decision: null, flips: 0, composing: false };

  const show = (decision) => {
    if (!decision || decision.path === 'none') return; // keep the face already shown
    if (state.decision && faceId(state.decision) !== faceId(decision)) state.flips += 1;
    state.decision = decision;
    draft.fontDecision = stored(decision);
    applyTextFont(ed, draft);
    // Read by tests and by nothing else: which face the editor is painting.
    ed.dataset.fontPath = decision.path;
    ed.dataset.fontFace = decision.face || decision.key || '';
  };

  // First decision, on whatever the editor holds now (normally the untouched
  // prefill). A prefill that itself contains a char nothing can write (a
  // Wingdings bullet) is NOT altered here — the user has not typed, and an
  // unchanged commit must stay a no-op. The face shown is the one the rest of
  // the line decides; the char is refused the moment the line is edited.
  const first = decideLineFont(state.accepted, live);
  if (first.path !== 'none') {
    show(first);
  } else {
    const rest = [...state.accepted].filter((ch) => !first.blocked.includes(ch)).join('');
    show(decideLineFont(rest, live));
  }

  const onInput = () => {
    if (state.composing) return; // IME: judge the composed text, not its pieces
    const next = ed.textContent;
    const r = acceptLineInput(state.accepted, next, live);
    if (r.text !== next) replaceText(ed, next, r.text);
    if (r.refused && onRefuse) onRefuse(r.refused);
    state.accepted = r.text;
    show(r.decision);
  };

  // A typed character NO font can write is refused before it lands, so the
  // selected prefill it would have replaced stays intact. Only cancelable
  // plain insertions — composition (most phone keyboards) is not cancelable
  // and falls to the input handler above, which strips it after the fact.
  ed.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertText' || !e.data || !e.cancelable) return;
    const blocked = [...e.data].filter((ch) => decideLineFont(ch, live).path === 'none');
    if (blocked.length === 0 || blocked.length !== [...e.data].length) return;
    e.preventDefault();
    if (onRefuse) onRefuse(blocked[0]);
  });
  ed.addEventListener('input', onInput);
  ed.addEventListener('compositionstart', () => { state.composing = true; });
  ed.addEventListener('compositionend', () => { state.composing = false; onInput(); });

  return {
    // The decision for the text being committed, decided NOW (not from the
    // last input event) so a commit can never carry a stale face.
    decideNow(text) {
      return stored(decideLineFont(text, live));
    },
    get flips() { return state.flips; },
  };
}
