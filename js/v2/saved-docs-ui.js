/*
 * PDFLokal — v2/saved-docs-ui.js  (the reopen dialog and the saved list)
 * ============================================================================
 * Two native <dialog>s, as every other dialog of this app (index.html: the global
 * `dialog` rule IS the overlay, so the content rides in a `.sheet` child):
 *
 *   #saved-ask   the REOPEN ASK. A returning visitor on the homepage, with an
 *                autosave that no other tab has open, is asked whether to pick it
 *                up. It is a dialog ON PURPOSE for about a month: its second job is
 *                to announce the feature (spec). Afterwards it retires into an
 *                option in the dropzone (a TODO the seat dates when this ships).
 *   #saved-list  every saved entry, openable and deletable; how much browser
 *                storage PDFLokal uses; a plain note that this is the user's own
 *                browser, and a Safari-only note about the 7-day wipe.
 *
 * THE BOTTOM-RIGHT CORNER IS THE OJAN CARD'S. Nothing here goes there, and
 * maybeAskReopen() returns a promise that settles when the ask is decided/closed
 * so maker-card.js can wait for it (the two never show together).
 *
 * File names are user-controlled: every node is built with textContent, never
 * innerHTML (CLAUDE.md gotchas), and neither dialog is in the replay-privacy
 * unmask list (index.html record_unmask_text_selector): a name is document content.
 *
 * ALL STRINGS are locales/*.js `saved.*`, DRAFT until the seat rewrites them.
 */
import { t, numberLocale, formatDecimal } from '../lib/i18n.js';
import { reopenCandidate, needsSafariNote } from '../core/saved-docs.js';
import { savedCountBucket } from '../core/telemetry-schema.js';

// A dialog shell from index.html, or one made on the spot when a STALE html (an
// old cached page beside a new app.js) does not carry it: a missing element costs
// this feature, never the editor (see app.js on()).
function shell(id, className) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = id;
    document.body.appendChild(dlg);
  }
  let sheet = dlg.querySelector('.sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.className = `sheet ${className}`;
    dlg.appendChild(sheet);
  }
  return { dlg, sheet };
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// "5 Okt 14.05" / "Oct 5, 2:05 PM": the browser's own short date in the page language.
export function whenText(ms) {
  try {
    return new Date(ms).toLocaleString(numberLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${formatDecimal(Math.max(0.1, bytes / 1024), 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatDecimal(bytes / (1024 * 1024), 1)} MB`;
  return `${formatDecimal(bytes / (1024 * 1024 * 1024), 2)} GB`;
}

export function createSavedUi({ store, presence, session, tel, isLanding, isIntentPage }) {
  const safari = needsSafariNote(globalThis.navigator?.userAgent);

  // ---- the saved list ---------------------------------------------------------

  const list = shell('saved-list', 'sv-sheet');
  list.dlg.setAttribute('aria-label', t('saved.listTitle'));

  async function renderList({ announce = false } = {}) {
    let entries = [];
    let held = new Set();
    let est = null;
    try { entries = await store.list(); } catch { entries = []; }
    try { held = await presence.heldElsewhere(); } catch { /* single-tab */ }
    try { est = await store.estimate(); } catch { /* unknown */ }
    const own = new Set(session.ownIds());
    if (announce) tel('saved_list_open', { entries: savedCountBucket(entries.length) });

    const head = el('div', 'sv-head');
    head.append(el('h2', null, t('saved.listTitle')));
    const close = el('button', 'sv-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('saved.listClose'));
    close.addEventListener('click', () => list.dlg.close());
    head.append(close);

    const body = el('div', 'sv-body');
    const groups = [['manual', t('saved.listManual')], ['auto', t('saved.listAuto')]];
    let shown = 0;
    for (const [kind, label] of groups) {
      const rows = entries.filter((e) => e.kind === kind);
      if (!rows.length) continue;
      shown += rows.length;
      body.append(el('p', 'sv-group', label));
      const ul = el('ul', 'sv-list');
      for (const e of rows) ul.append(rowFor(e, { elsewhere: held.has(e.id), here: own.has(e.id) }));
      body.append(ul);
    }
    if (!shown) body.append(el('p', 'sv-empty', t('saved.listEmpty')));

    const foot = el('div', 'sv-foot');
    if (est) foot.append(el('p', 'sv-storage', t('saved.listStorage', { size: sizeText(est.usage) })));
    foot.append(el('p', 'sv-note', t('saved.listStorageNote')));
    if (safari) foot.append(el('p', 'sv-note sv-safari', t('saved.listSafari')));

    list.sheet.replaceChildren(head, body, foot);
  }

  function rowFor(e, { elsewhere, here }) {
    const li = el('li', 'sv-row');
    const main = el('div', 'sv-main');
    main.append(el('div', 'sv-name', e.name || ''));
    const bits = [whenText(e.updatedAt), t('saved.listPages', { count: e.pages }), sizeText((e.blobBytes || 0) + (e.stateBytes || 0))];
    main.append(el('div', 'sv-meta', bits.filter(Boolean).join(' · ')));
    if (elsewhere) main.append(el('div', 'sv-tag', t('saved.listElsewhere')));
    if (here) main.append(el('div', 'sv-tag', t('saved.listHere')));
    li.append(main);

    const acts = el('div', 'sv-acts');
    if (!here) {
      const open = el('button', 'sv-open', elsewhere ? t('saved.listOpenCopy') : t('saved.listOpen'));
      open.type = 'button';
      open.addEventListener('click', async () => {
        open.disabled = true;
        const ok = await session.openEntry(e.id);
        if (ok) list.dlg.close(); else open.disabled = false;
      });
      acts.append(open);
    }
    // An entry another tab holds is not deleted from under it.
    if (!elsewhere && !here) {
      const del = el('button', 'sv-del', t('saved.listDelete'));
      del.type = 'button';
      let armed = null;
      del.addEventListener('click', async () => {
        if (!armed) {
          del.textContent = t('saved.listDeleteSure');
          del.classList.add('sure');
          armed = setTimeout(() => { armed = null; del.textContent = t('saved.listDelete'); del.classList.remove('sure'); }, 4000);
          return;
        }
        clearTimeout(armed);
        del.disabled = true;
        if (await session.remove(e.id)) renderList(); else del.disabled = false;
      });
      acts.append(del);
    }
    li.append(acts);
    return li;
  }

  async function openList() {
    if (list.dlg.open) return;
    await renderList({ announce: true });
    if (!list.dlg.open) list.dlg.showModal();
  }
  list.dlg.addEventListener('click', (ev) => { if (ev.target === list.dlg) list.dlg.close(); });

  // ---- the reopen ask ----------------------------------------------------------

  const ask = shell('saved-ask', 'hc-sheet sv-ask');
  ask.dlg.setAttribute('aria-label', t('saved.askTitle'));

  // Resolves when the ask is settled: never shown, or closed. The Ojan card waits
  // on it. `limitMs` bounds the wait on a storage read that never answers: past it
  // the ask is abandoned for good (it must not appear on top of the card later).
  function maybeAskReopen({ limitMs = 3000 } = {}) {
    return new Promise((resolve) => {
      let abandoned = false;
      const done = () => resolve();
      const timer = setTimeout(() => { abandoned = true; done(); }, limitMs);
      (async () => {
        if (!isLanding() || isIntentPage()) return;
        const entries = await store.list();
        if (!entries.length) return;
        const candidate = reopenCandidate(entries, await presence.heldElsewhere());
        if (!candidate || abandoned || !isLanding()) return;

        const title = el('h2', null, t('saved.askTitle'));
        const body = el('p', null, t('saved.askBody'));
        const file = el('p', 'sv-askfile', t('saved.askWhen', { name: candidate.name || '', when: whenText(candidate.updatedAt) }));
        const open = el('button', 'sv-primary', t('saved.askOpen'));
        const later = el('button', null, t('saved.askLater'));
        const all = el('button', 'sv-link', t('saved.askAll'));
        for (const b of [open, later, all]) b.type = 'button';
        const row = el('div', 'hc-row');
        row.append(later, open);
        ask.sheet.replaceChildren(title, body, file, row, all);

        let accepted = false;
        later.addEventListener('click', () => ask.dlg.close());
        all.addEventListener('click', () => { ask.dlg.close(); openList(); });
        open.addEventListener('click', async () => {
          open.disabled = true;
          if (await session.openEntry(candidate.id)) { accepted = true; ask.dlg.close(); } else open.disabled = false;
        });
        ask.dlg.addEventListener('close', () => {
          tel('autosave_restore', { action: accepted ? 'accepted' : 'declined' });
          done();
        }, { once: true });
        tel('autosave_restore', { action: 'offered' });
        ask.dlg.showModal();
        open.focus();
      })().catch(() => { /* a store that will not open: no ask, no harm */ }).finally(() => {
        clearTimeout(timer);
        if (!ask.dlg.open) done();
      });
    });
  }

  return { openList, maybeAskReopen, listDialog: list.dlg, askDialog: ask.dlg };
}
