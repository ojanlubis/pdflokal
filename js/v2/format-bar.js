/*
 * PDFLokal — v2/format-bar.js  (contextual text formatting)
 * ============================================================================
 * The Word/Figma-style bar for the #1 user action (text = ~30% of edits).
 * Appears only when text is relevant: a text annotation is selected, the
 * inline editor is open, or the Teks tool is armed (progressive disclosure —
 * a crowded toolbar is a bug).
 *
 * Style is STICKY (Canva behavior): the bar's current values are the defaults
 * for the next new text annotation. Editing a selected annotation records one
 * undo step per discrete change and goes through updateAnnotation (invariant #5).
 */

import { updateAnnotation, freesEdit } from '../core/operations.js';
import { isUserFont, userFontCss } from '../core/user-fonts.js';
import { record } from '../core/history.js';
import { FONT_CSS } from '../render/page-view.js';
import { FONT_SIZE_PRESETS, parseFontSize, formatFontSize } from '../core/font-size.js';
import { t as tr } from '../lib/i18n.js';

const COLORS = ['#000000', '#d33131', '#1d6fdc', '#1d8a44', '#ffffff'];

// Paragraph alignment (his ask 2026-11-12, "rata kiri, tengah atau kanan").
// Justify only means something inside a box of fixed width, so it is offered
// for an Edit paragraph (Rung D, which has one) and not for typed Teks text
// (which is as wide as its widest line). Icons: four lines, the text editors'
// usual picture of each alignment.
const ALIGNS = [
  { value: 'left', label: () => tr('format.alignLeft'), lines: [[3, 17], [3, 13], [3, 17], [3, 11]] },
  { value: 'center', label: () => tr('format.alignCenter'), lines: [[3, 17], [5, 15], [3, 17], [6, 14]] },
  { value: 'right', label: () => tr('format.alignRight'), lines: [[3, 17], [7, 17], [3, 17], [9, 17]] },
  { value: 'justify', label: () => tr('format.alignJustify'), lines: [[3, 17], [3, 17], [3, 17], [3, 11]] },
];
const SVG_NS = 'http://www.w3.org/2000/svg';
function alignIcon(lines) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  lines.forEach(([x1, x2], i) => {
    const l = document.createElementNS(SVG_NS, 'line');
    const y = String(4 + i * 4);
    l.setAttribute('x1', String(x1)); l.setAttribute('x2', String(x2));
    l.setAttribute('y1', y); l.setAttribute('y2', y);
    l.setAttribute('stroke', 'currentColor');
    l.setAttribute('stroke-width', '2');
    l.setAttribute('stroke-linecap', 'round');
    svg.appendChild(l);
  });
  return svg;
}

// deps = {
//   el:        the bar container (in editor-v2.html)
//   getDoc, history
//   getTarget: () => text annotation currently selected/being edited (or null)
//   onStyled:  (anno) => void — re-render after a committed style change
//   onDefaults:(defaults) => void — restyle an OPEN, UNCOMMITTED draft. Taken
//     whenever getTarget() returns null, i.e. while the user is styling text
//     they are still typing, which is the majority path for the action this
//     bar exists for. It was missing from this list until 2026-08-09, and the
//     call at line ~126 is optional-chained — so a caller that wired itself
//     from this comment would get no error, just a format bar that silently
//     stops affecting the draft under the cursor. Documented because the
//     failure is silence, not a throw.
//   getBlockPlan: () => the plan of an Edit PARAGRAPH draft being typed (Rung D,
//     its `block`), or null. While one is open the bar shows ONLY alignment:
//     an edit keeps the original's face, size and colour (founder ruling
//     2026-07-18), but where the lines sit in the box is his to choose
//     (2026-11-12).
//   onBlockAlign: (align) => void — restyle that draft's editor after its
//     plan's align changed.
//   getEditDraft: () => the open Edit draft (a replace being typed, js/v2/app.js
//     openTextEditor's `draft`), or null. His call 2026-11-27: Edit does what
//     Teks does, so the WHOLE bar shows over an Edit and a change lands on
//     that draft (never on the sticky defaults, which are the next Teks's).
//     A face, size or weight frees the edit (core/operations.js freesEdit).
//   onEditDraftStyled: (draft) => void — restyle that draft's editor.
//   onControlDone: () => void — a control that took focus (font, size on
//     Enter, custom colour on close) has finished. app.js hands focus back to
//     an empty draft that blurCommitsDraft kept open; otherwise a no-op.
// }
// The one rule for "which annotation does the bar style". WHY editingEl blocks
// the selection fallback: a NEW text being typed has an editor but no
// annotation yet, while the previously committed text stays selected (app.js
// keeps authored text selected after commit). Falling through to that
// selection restyled the OLD text and left the draft unchanged.
export function formatTarget({ editingAnno, editingEl, selected }) {
  if (editingAnno) return editingAnno;
  return editingEl ? null : selected;
}

// The one rule for "does leaving the inline editor commit it". WHY an empty
// NEW draft blurring into the bar does not: the font select, the size field
// and the custom colour take focus. For typed text the commit is what creates
// the annotation the control then styles (commit-and-stay-selected). For an
// empty draft it commits to NOTHING: the box closed, Teks disarmed, and with no
// editor left formatTarget fell through to the previously committed text,
// which took the size meant for the next one. Kept open, editingEl stays set,
// so the change restyles the draft. A null relatedTarget (a browser that does
// not say where focus went) commits, as before: never a stranded editor.
// An EDIT draft (hasDraft) is held the same way, typed or not (his call
// 2026-11-27, the whole bar over an Edit): committing it on the way into the
// bar would close the Edit (an untouched one cancels) and the pick would land
// on the next Teks's defaults instead (format-bar.js getEditDraft).
export function blurCommitsDraft({ relatedTarget, barEl, text, hasAnno, hasDraft }) {
  const intoBar = !!relatedTarget && !!barEl?.contains(relatedTarget);
  if (intoBar && hasDraft && !hasAnno) return false;
  return !(intoBar && !text && !hasAnno && !hasDraft);
}

export function createFormatBar(deps) {
  const { el } = deps;
  // Sticky defaults for the NEXT new text annotation.
  const defaults = { fontFamily: 'Helvetica', fontSize: 18, bold: false, italic: false, color: '#000000', align: 'left' };

  // ---- build the controls once ------------------------------------------------
  el.innerHTML = '';

  const fontSel = document.createElement('select');
  fontSel.className = 'fb-font';
  fontSel.setAttribute('aria-label', tr('format.font'));
  // The metric clones ARE authoring choices (founder ruling 2026-07-20
  // evening: "yes, add them" — overriding the keep-it-5 recommendation).
  // Their family names mean nothing to users, so each label carries the
  // familiar font it matches — the label answers "what does this look like"
  // without a decode step.
  const FONT_LABELS = {
    'Times-Roman': 'Times',
    'Arimo': 'Arimo (Arial)',
    'Tinos': 'Tinos (Times New Roman)',
    'Cousine': 'Cousine (Courier New)',
    'Caladea': 'Caladea (Cambria)',
  };
  // The list: the bundled faces, then the fonts this user brought
  // (core/user-fonts.js, his call 2026-11-27), then the row that adds one.
  // Rebuilt whenever a font is added, so the new one is in the list it was
  // picked from.
  const ADD_FONT = '__add-font__';
  function fillFonts() {
    fontSel.textContent = '';
    for (const name of Object.keys(FONT_CSS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = FONT_LABELS[name] || name;
      opt.style.fontFamily = FONT_CSS[name];
      fontSel.appendChild(opt);
    }
    for (const f of deps.userFonts?.() || []) {
      const opt = document.createElement('option');
      opt.value = f.key;
      opt.textContent = f.name;
      opt.style.fontFamily = `"${userFontCss(f.key)}"`;
      fontSel.appendChild(opt);
    }
    if (deps.addUserFont) {
      const opt = document.createElement('option');
      opt.value = ADD_FONT;
      opt.textContent = tr('format.addFont');
      fontSel.appendChild(opt);
    }
  }
  fillFonts();
  el.appendChild(fontSel);

  // Size = a typed number plus presets (founder 2026-10-01: the old <select>
  // bottomed out at 10 and could not be typed into). type=text + inputmode
  // =decimal, not type=number: number inputs reject a comma, and Indonesian
  // keyboards type "7,5". 16px font in CSS or iOS zooms the page on focus.
  const sizeIn = document.createElement('input');
  sizeIn.type = 'text';
  sizeIn.inputMode = 'decimal';
  sizeIn.autocomplete = 'off';
  sizeIn.className = 'fb-size';
  sizeIn.setAttribute('aria-label', tr('format.size'));
  const sizeList = document.createElement('datalist');
  sizeList.id = 'fb-size-presets';
  for (const s of FONT_SIZE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    sizeList.appendChild(opt);
  }
  sizeIn.setAttribute('list', sizeList.id);
  el.appendChild(sizeIn);
  el.appendChild(sizeList);

  const boldBtn = document.createElement('button');
  boldBtn.className = 'fb-toggle fb-bold';
  boldBtn.textContent = 'B';
  boldBtn.setAttribute('aria-label', tr('format.bold'));
  boldBtn.setAttribute('aria-pressed', 'false');
  el.appendChild(boldBtn);

  const italicBtn = document.createElement('button');
  italicBtn.className = 'fb-toggle fb-italic';
  italicBtn.textContent = 'I';
  italicBtn.setAttribute('aria-label', tr('format.italic'));
  italicBtn.setAttribute('aria-pressed', 'false');
  el.appendChild(italicBtn);

  const swatches = [];
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'fb-color';
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute('aria-label', tr('format.color', { color: c }));
    el.appendChild(b);
    swatches.push(b);
  }
  // Beyond the presets: the full palette (founder ask). A native color input
  // wearing a swatch costume — free UI, works everywhere, no popover to build.
  const customColor = document.createElement('input');
  customColor.type = 'color';
  customColor.className = 'fb-color fb-color-custom';
  customColor.setAttribute('aria-label', tr('format.moreColors'));
  customColor.title = tr('format.moreColors');
  el.appendChild(customColor);

  const alignGroup = document.createElement('div');
  alignGroup.className = 'fb-align';
  alignGroup.setAttribute('role', 'group');
  alignGroup.setAttribute('aria-label', tr('format.align'));
  const alignBtns = ALIGNS.map((a) => {
    const b = document.createElement('button');
    b.className = 'fb-toggle fb-align-btn';
    b.dataset.align = a.value;
    b.setAttribute('aria-label', a.label());
    b.title = a.label();
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(alignIcon(a.lines));
    alignGroup.appendChild(b);
    return b;
  });
  el.appendChild(alignGroup);

  // ---- state sync ---------------------------------------------------------------
  function reflect(style) {
    fontSel.value = style.fontFamily || 'Helvetica';
    // A user font the list does not hold (a saved document whose font this
    // browser no longer keeps) shows as the face it falls back to.
    if (fontSel.value !== (style.fontFamily || 'Helvetica')) fontSel.value = 'Helvetica';
    // One face per brought font: bold/italic would be faked on screen and
    // ignored in the file (core/export.js embedUserFont), so they rest.
    const oneFace = isUserFont(style.fontFamily);
    boldBtn.disabled = oneFace;
    italicBtn.disabled = oneFace;
    sizeIn.value = formatFontSize(style.fontSize || 18);
    boldBtn.classList.toggle('on', !!style.bold);
    boldBtn.setAttribute('aria-pressed', String(!!style.bold));
    italicBtn.classList.toggle('on', !!style.italic);
    italicBtn.setAttribute('aria-pressed', String(!!style.italic));
    const cur = style.color || '#000000';
    const isPreset = COLORS.includes(cur);
    for (const s of swatches) s.classList.toggle('on', s.dataset.color === cur);
    customColor.classList.toggle('on', !isPreset);
    customColor.value = cur;
    reflectAlign();
  }

  // The bar's three states: hidden, Teks (every control; no justify), and an
  // Edit paragraph draft (alignment only, justify included). A committed
  // paragraph selected afterwards gets no alignment: its lines are already
  // baked into the page, and changing them is a re-edit.
  function alignTarget() {
    const plan = deps.getBlockPlan?.() || null;
    if (plan) return { kind: 'block', align: plan.align || 'left' };
    // A one-line Edit has no box for its line to sit in.
    if (deps.getEditDraft?.()) return null;
    const anno = deps.getTarget();
    if (anno && anno.block) return null;
    return { kind: 'text', align: (anno || defaults).align || 'left' };
  }
  function reflectAlign() {
    const at = alignTarget();
    alignGroup.hidden = !at;
    for (const b of alignBtns) {
      const isJustify = b.dataset.align === 'justify';
      b.hidden = isJustify && at?.kind !== 'block';
      const on = !!at && at.align === b.dataset.align;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  function setAlign(value) {
    const at = alignTarget();
    if (!at || at.align === value) return;
    if (at.kind === 'block') {
      // Not a model change yet: the draft's plan rides the commit
      // (core/block-edit.js blockAnnotation), which takes the undo step.
      deps.getBlockPlan().align = value;
      deps.onBlockAlign?.(value);
      reflectAlign();
      return;
    }
    apply({ align: value });
  }

  // `record: false` = a continuation of a change whose undo step is already taken
  // (the colour picker's drag, see below).
  function apply(patch, { record: recordStep = true } = {}) {
    const draft = deps.getEditDraft?.() || null;
    if (draft) {
      // Not a model change yet: the draft rides the commit, which takes the
      // undo step (js/v2/app.js). Same freeing rule as a committed edit.
      if (freesEdit({ ...draft, type: 'text', replaceCoverId: draft.replaceCoverId || draft.reEdit?.coverId || 'draft' }, patch)) draft.detached = true;
      Object.assign(draft, patch);
      draft.styled = true;
      deps.onEditDraftStyled?.(draft);
      reflect(draft);
      return;
    }
    Object.assign(defaults, patch);          // sticky for the next new text
    const anno = deps.getTarget();
    if (anno) {
      if (recordStep) record(deps.history, deps.getDoc());
      updateAnnotation(deps.getDoc(), anno.id, patch);
      deps.onStyled?.(anno);
    } else {
      deps.onDefaults?.(defaults);           // restyle an open un-committed draft
    }
    reflect(anno || defaults);
  }

  fontSel.addEventListener('change', async () => {
    if (fontSel.value !== ADD_FONT) { apply({ fontFamily: fontSel.value }); deps.onControlDone?.(); return; }
    // Back to the current face while the picker is open: cancelling it must
    // leave the select showing the truth.
    reflect(deps.getEditDraft?.() || deps.getTarget() || defaults);
    const added = await deps.addUserFont();
    if (added?.ok) {
      fillFonts();
      apply({ fontFamily: added.key, bold: false, italic: false });
    }
    deps.onControlDone?.();
  });
  // Commit on change and on Enter. Both can fire for one edit, so a commit
  // whose text already equals the current size's display is a no-op: no second
  // undo step, and a fractional size from a document line (7.395, shown as
  // "7.4") is never rewritten unless the user actually changes it.
  function commitSize() {
    const cur = (deps.getEditDraft?.() || deps.getTarget() || defaults).fontSize || 18;
    const raw = sizeIn.value.trim();
    if (raw !== '' && raw !== formatFontSize(cur)) {
      const n = parseFontSize(raw, cur);
      if (n !== cur) { apply({ fontSize: n }); return; }
    }
    reflect(deps.getEditDraft?.() || deps.getTarget() || defaults);   // garbage / empty / unchanged: show the real value
  }
  sizeIn.addEventListener('change', commitSize);
  sizeIn.addEventListener('keydown', (e) => {
    // onControlDone before blur: a held draft takes focus back, so this blur
    // is a no-op and the field's own blur below never sees an empty target.
    if (e.key === 'Enter') { e.preventDefault(); commitSize(); deps.onControlDone?.(); sizeIn.blur(); }
  });
  // Browsers filter a datalist by the field's current text, so a field showing
  // "18" would offer only "18". Empty it on focus (the size stays visible as
  // the placeholder) so the whole preset list opens; blur puts the value back.
  sizeIn.addEventListener('focus', () => {
    sizeIn.placeholder = sizeIn.value;
    sizeIn.value = '';
  });
  sizeIn.addEventListener('blur', () => {
    sizeIn.placeholder = '';
    commitSize();
  });
  // SINGLE SOURCE OF TRUTH for bold/italic: the buttons AND the Ctrl/Cmd+B/I
  // shortcuts (app.js) both come through here, so a shortcut can never differ
  // from the button in scope (whole box), undo step, or aria-pressed state.
  const styleNow = () => deps.getEditDraft?.() || deps.getTarget() || defaults;
  // A brought font has one face (reflect disables the buttons); the
  // Ctrl/Cmd+B/I shortcuts come through here too, so they rest with them.
  function toggleBold() { if (!isUserFont(styleNow().fontFamily)) apply({ bold: !styleNow().bold }); }
  function toggleItalic() { if (!isUserFont(styleNow().fontFamily)) apply({ italic: !styleNow().italic }); }
  boldBtn.addEventListener('click', toggleBold);
  italicBtn.addEventListener('click', toggleItalic);
  for (const s of swatches) s.addEventListener('click', () => apply({ color: s.dataset.color }));
  for (const b of alignBtns) b.addEventListener('click', () => setAlign(b.dataset.align));
  // 'input' fires on every tick while dragging inside the OS picker → live
  // preview on the text. WHY only the FIRST tick records: one undo step per tick
  // meant a single drag left a dozen steps, and Ctrl+Z walked back through shades
  // nobody chose. A whole drag is ONE step, taken before the first tick changes
  // anything, so undo returns to the colour the text had when the picker opened.
  // 'change' (picker closed, or a browser that fires only that) ends the drag;
  // with no tick before it, it is itself the one step. Blur ends it too, so an
  // abandoned picker cannot swallow the next session's step.
  let pickerDragging = false;
  customColor.addEventListener('input', () => {
    apply({ color: customColor.value }, { record: !pickerDragging });
    pickerDragging = true;
  });
  customColor.addEventListener('change', () => {
    if (!pickerDragging) apply({ color: customColor.value });
    pickerDragging = false;
    deps.onControlDone?.();
  });
  customColor.addEventListener('blur', () => { pickerDragging = false; });

  // Keep taps inside the bar from bubbling into the stage (deselecting), and
  // keep BUTTON taps from stealing focus (which would blur-commit an open
  // inline editor). Selects and the size field are exempt — they need focus; a
  // typed draft commits-and-stays-selected instead (app.js), so the change still
  // lands, and an empty one stays open (blurCommitsDraft).
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.target.closest('button')) e.preventDefault();
  });

  return {
    // Show when text is in play; reflect the target's style (or the defaults).
    sync(visible) {
      const anno = deps.getEditDraft?.() || deps.getTarget();
      el.classList.toggle('show', !!visible);
      reflect(anno || defaults);
    },
    getDefaults: () => ({ ...defaults }),
    // Fonts this browser kept load after the bar is built (js/v2/user-fonts.js).
    refreshFonts() { fillFonts(); reflect(styleNow()); },
    toggleBold,
    toggleItalic,
  };
}
