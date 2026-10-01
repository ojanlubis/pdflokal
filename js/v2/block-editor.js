/*
 * PDFLokal — v2/block-editor.js  (Rung D: the paragraph editor's DOM half)
 * ============================================================================
 * core/block-edit.js decides whether a tapped paragraph can be edited as one
 * and where its lines go in the file. This file makes the Ganti editor (the
 * same contenteditable js/v2/app.js openTextEditor builds) behave as that
 * paragraph's box while the user types:
 *
 *   - the box: the paragraph's own width, leading, alignment and first-line
 *     indent; the text wraps inside it (white-space: pre-wrap) and the box
 *     grows downward, never wider (spec-rung-d-reflow.md §6);
 *   - its first baseline sits on the paragraph's original first baseline,
 *     measured, not assumed (where a baseline sits inside a CSS line box
 *     depends on the face's ascent, so it is re-measured on every face change);
 *   - at commit, readEditorLines reads back the line breaks the browser
 *     PAINTED. Those breaks are what gets stored and stamped: THE EDIT
 *     PRINCIPLE (his, seat decisions.md 2026-10-01) — what the user sees while
 *     typing is what the file contains — held for line breaks by reading them
 *     off the screen rather than predicting them with a second wrap engine.
 */

const WS = /[ \t\u00A0]/;

// The paragraph's box on the editor element. Line height is not set here:
// render/page-view.js applyTextFont owns it (the `font` shorthand resets it on
// every face change, so it is re-applied there from the draft's `block`).
export function styleBlockEditor(ed, plan) {
  const k = plan.k;
  ed.style.whiteSpace = 'pre-wrap';
  ed.style.overflowWrap = 'normal';
  ed.style.wordBreak = 'normal';
  ed.style.minWidth = '0';
  ed.style.padding = '0';
  ed.style.width = `${k * plan.width}px`;
  ed.style.textAlign = plan.align;
  ed.style.textIndent = `${plan.align === 'right' ? 0 : k * (plan.indent || 0)}px`;
  ed.style.left = `${plan.disp.x}px`;
  ed.dataset.block = plan.align;
}

// Where the first baseline sits below the top of a line box in the editor's
// CURRENT face, size and line height, in the editor's own (unzoomed) px. A
// zero-height inline-block aligned to the baseline has its top ON the
// baseline; measured in a hidden shallow CLONE of the editor (every inline
// style copied — `el.style.font` alone reads back '' once a longhand like
// font-kerning is set, measured 2026-10-01), never inside the contenteditable
// itself (that would put a node into the user's text).
function baselineOffset(ed) {
  const m = ed.cloneNode(false);
  m.removeAttribute('contenteditable');
  m.removeAttribute('data-font-path');
  m.style.visibility = 'hidden';
  m.style.top = '0px';
  m.style.outline = 'none';
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  m.append(probe, document.createTextNode('Hg'));
  ed.parentNode.appendChild(m);
  const rect = m.getBoundingClientRect();
  const scale = rect.width / (m.offsetWidth || 1) || 1;
  const off = (probe.getBoundingClientRect().top - rect.top) / scale;
  m.remove();
  return off;
}

// Put the editor's first baseline on the paragraph's first baseline. Call after
// the editor is in the DOM, and again whenever its face changes. Returns the
// top it set (page-space px).
export function placeBlockEditor(ed, plan) {
  if (!ed.isConnected || !ed.parentNode) return null;
  const top = plan.disp.y - baselineOffset(ed);
  ed.style.top = `${top}px`;
  return top;
}

// The line breaks the editor PAINTED, read off the layout: [{ text, brk }],
// where `brk` is exactly what the break consumed — the whitespace a soft wrap
// hung at the line's end ('' when the browser broke after a hyphen), plus
// '\n' for a typed break. core/block-edit.js logicalTextOf(lines) rebuilds the
// text from them. Leading and trailing whitespace of the whole text is dropped
// (the commit trims, as the line editor always has).
//
// A non-space character starts a new line when its box sits lower than the
// current line's by more than half a line: that is a wrap. Spaces never start
// a line here — in pre-wrap they hang at the end of the line they follow.
export function readEditorLines(ed) {
  const chars = [];
  const walker = document.createTreeWalker(ed, window.NodeFilter.SHOW_TEXT | window.NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (n.tagName === 'BR') chars.push({ ch: '\n', top: null });
      continue;
    }
    const data = n.data;
    let i = 0;
    for (const ch of data) {
      let top = null;
      if (ch !== '\n' && !WS.test(ch)) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + ch.length);
        const rect = r.getClientRects()[0];
        if (rect) top = rect.top;
      }
      chars.push({ ch, top });
      i += ch.length;
    }
  }
  // Trim the whole text's edges.
  let a = 0;
  let b = chars.length;
  while (a < b && (chars[a].ch === '\n' || WS.test(chars[a].ch))) a += 1;
  while (b > a && (chars[b - 1].ch === '\n' || WS.test(chars[b - 1].ch))) b -= 1;

  const rect = ed.getBoundingClientRect();
  const scale = rect.height / (ed.offsetHeight || 1) || 1;
  const half = 0.5 * (parseFloat(ed.style.lineHeight) || 0) * scale;

  const lines = [];
  let cur = '';
  let curTop = null;
  const close = (hard) => {
    const m = /[ \t\u00A0]*$/.exec(cur);
    lines.push({ text: cur.slice(0, m.index), brk: m[0] + (hard ? '\n' : '') });
    cur = '';
    curTop = null;
  };
  for (let j = a; j < b; j += 1) {
    const { ch, top } = chars[j];
    if (ch === '\n') { close(true); continue; }
    if (top !== null) {
      if (curTop !== null && top > curTop + half) close(false);
      if (curTop === null) curTop = top;
    }
    cur += ch;
  }
  if (cur || lines.length === 0) close(false);
  lines[lines.length - 1].brk = '';
  return lines;
}
