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

import { updateAnnotation } from '../core/operations.js';
import { record } from '../core/history.js';
import { FONT_CSS } from '../render/page-view.js';

const SIZES = [10, 12, 14, 18, 24, 32, 48, 64];
const COLORS = ['#000000', '#d33131', '#1d6fdc', '#1d8a44', '#ffffff'];

// deps = {
//   el:        the bar container (in editor-v2.html)
//   getDoc, history
//   getTarget: () => text annotation currently selected/being edited (or null)
//   onStyled:  (anno) => void — re-render after a committed style change
// }
export function createFormatBar(deps) {
  const { el } = deps;
  // Sticky defaults for the NEXT new text annotation.
  const defaults = { fontFamily: 'Helvetica', fontSize: 18, bold: false, italic: false, color: '#000000' };

  // ---- build the controls once ------------------------------------------------
  el.innerHTML = '';

  const fontSel = document.createElement('select');
  fontSel.className = 'fb-font';
  fontSel.setAttribute('aria-label', 'Jenis huruf');
  for (const name of Object.keys(FONT_CSS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name === 'Times-Roman' ? 'Times' : name;
    opt.style.fontFamily = FONT_CSS[name];
    fontSel.appendChild(opt);
  }
  el.appendChild(fontSel);

  const sizeSel = document.createElement('select');
  sizeSel.className = 'fb-size';
  sizeSel.setAttribute('aria-label', 'Ukuran huruf');
  for (const s of SIZES) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = String(s);
    sizeSel.appendChild(opt);
  }
  el.appendChild(sizeSel);

  const boldBtn = document.createElement('button');
  boldBtn.className = 'fb-toggle fb-bold';
  boldBtn.textContent = 'B';
  boldBtn.setAttribute('aria-label', 'Tebal');
  boldBtn.setAttribute('aria-pressed', 'false');
  el.appendChild(boldBtn);

  const italicBtn = document.createElement('button');
  italicBtn.className = 'fb-toggle fb-italic';
  italicBtn.textContent = 'I';
  italicBtn.setAttribute('aria-label', 'Miring');
  italicBtn.setAttribute('aria-pressed', 'false');
  el.appendChild(italicBtn);

  const swatches = [];
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'fb-color';
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute('aria-label', `Warna ${c}`);
    el.appendChild(b);
    swatches.push(b);
  }
  // Beyond the presets: the full palette (founder ask). A native color input
  // wearing a swatch costume — free UI, works everywhere, no popover to build.
  const customColor = document.createElement('input');
  customColor.type = 'color';
  customColor.className = 'fb-color fb-color-custom';
  customColor.setAttribute('aria-label', 'Warna lainnya');
  customColor.title = 'Warna lainnya';
  el.appendChild(customColor);

  // ---- state sync ---------------------------------------------------------------
  function reflect(style) {
    fontSel.value = style.fontFamily || 'Helvetica';
    sizeSel.value = String(style.fontSize || 18);
    boldBtn.classList.toggle('on', !!style.bold);
    boldBtn.setAttribute('aria-pressed', String(!!style.bold));
    italicBtn.classList.toggle('on', !!style.italic);
    italicBtn.setAttribute('aria-pressed', String(!!style.italic));
    const cur = style.color || '#000000';
    const isPreset = COLORS.includes(cur);
    for (const s of swatches) s.classList.toggle('on', s.dataset.color === cur);
    customColor.classList.toggle('on', !isPreset);
    customColor.value = cur;
  }

  function apply(patch) {
    Object.assign(defaults, patch);          // sticky for the next new text
    const anno = deps.getTarget();
    if (anno) {
      record(deps.history, deps.getDoc());
      updateAnnotation(deps.getDoc(), anno.id, patch);
      deps.onStyled?.(anno);
    } else {
      deps.onDefaults?.(defaults);           // restyle an open un-committed draft
    }
    reflect(anno || defaults);
  }

  fontSel.addEventListener('change', () => apply({ fontFamily: fontSel.value }));
  sizeSel.addEventListener('change', () => apply({ fontSize: Number(sizeSel.value) }));
  boldBtn.addEventListener('click', () => apply({ bold: !(deps.getTarget() || defaults).bold }));
  italicBtn.addEventListener('click', () => apply({ italic: !(deps.getTarget() || defaults).italic }));
  for (const s of swatches) s.addEventListener('click', () => apply({ color: s.dataset.color }));
  // 'input' fires while dragging inside the OS picker → live preview on the text.
  customColor.addEventListener('input', () => apply({ color: customColor.value }));

  // Keep taps inside the bar from bubbling into the stage (deselecting), and
  // keep BUTTON taps from stealing focus (which would blur-commit an open
  // inline editor). Selects are exempt — a dropdown needs focus to open; the
  // draft commits-and-stays-selected instead (app.js), so the change still lands.
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.target.closest('button')) e.preventDefault();
  });

  return {
    // Show when text is in play; reflect the target's style (or the defaults).
    sync(visible) {
      const anno = deps.getTarget();
      el.classList.toggle('show', !!visible);
      reflect(anno || defaults);
    },
    getDefaults: () => ({ ...defaults }),
  };
}
