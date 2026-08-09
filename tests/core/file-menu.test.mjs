/*
 * THE FILE MENU IS THREE ITEMS, AND THE THIRD ONE IS NOT A SECOND IMPLEMENTATION.
 * ============================================================================
 * His ruling, 2026-08-09 (decisions.md, thread N2): the `File ▾` dropdown is
 * `Tambah File` · `Buka Baru` · `Atur Halaman`, the grey inline notes (`gabung`,
 * `ganti semua`) are deleted, and the meaning they carried moves to a hover
 * tooltip. Two follow-ups the same day: the toolbar `Halaman` button STAYS
 * (N2 a — "it's okay that it's double, bcs it's hidden behind a 'file' dropdown
 * anyway"), and the touch loss is ACCEPTED (N2 b — hover does not exist on a
 * phone, he was told, he took none of the three ways out).
 *
 * ⚠️ WHY THIS TEST IS STATIC AND NOT A BROWSER TEST. Three of the four claims
 * are claims about the SOURCE, not about a rendered frame: that there is one
 * opener rather than two, that the deleted markup is really gone, and that the
 * toolbar route survives. A Playwright run proves the sheet opens; it cannot
 * prove the second route didn't get there by copy-pasting the first. The
 * browser half lives in tests/kelola-halaman.spec.js.
 *
 * ⚠️ WHY IT ASSERTS THE ORDER AND NOT JUST THE SET. He named the order. A set
 * assertion passes on a menu that reads `Atur Halaman` · `Tambah File` ·
 * `Buka Baru`, which is not what he ruled.
 *
 * ⚠️ WHY IT ASSERTS `fm-note` IS ABSENT FROM THE WHOLE FILE, not from the menu
 * block. The class had a CSS rule too. Deleting the spans and leaving the rule
 * is the "presence is not landing" shape: the DOM looks right and the stylesheet
 * still carries a selector for a thing that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');

// The menu block: from `<div id="file-menu"` to its closing tag. The block
// contains no nested <div>, only <button> and <svg>, so the first `</div>`
// after the opener is the right one — asserted below rather than assumed.
function fileMenuBlock() {
  const start = HTML.indexOf('<div id="file-menu"');
  assert.ok(start !== -1, 'no <div id="file-menu"> in index.html — the menu is gone');
  const end = HTML.indexOf('</div>', start);
  assert.ok(end !== -1, 'the file menu never closes');
  // Slice from AFTER the menu's own opening tag, or the nested-<div> guard below
  // would trip on that tag itself — the guard would then be the thing that is
  // broken, and the honest-looking fix would be to delete it.
  const block = HTML.slice(HTML.indexOf('>', start) + 1, end);
  assert.ok(!block.includes('<div'), 'the menu block gained a nested <div>; this slicer is now wrong');
  return block;
}

// Comment-stripped source, same discipline as telemetry-coverage.test.mjs: this
// repo discusses its own identifiers in prose, and a scanner that counts prose
// hits produces noise that gets the assertion deleted rather than fixed.
const stripJs = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const APP_CODE = stripJs(APP);

const EXPECTED = [
  { id: 'fm-add', label: 'Tambah File' },
  { id: 'fm-new', label: 'Buka Baru' },
  { id: 'fm-pages', label: 'Atur Halaman' },
];

test('1. the File menu is exactly three items, in his order, with his labels', () => {
  const block = fileMenuBlock();

  // VACUITY GUARD: an empty or mis-sliced block would make every `includes`
  // below pass by finding nothing to contradict it.
  assert.ok(block.length > 200, `menu block is ${block.length} chars — the slice is wrong`);

  const items = [...block.matchAll(/<button\b[^>]*\brole="menuitem"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(items.length, 3, `expected 3 menu items, found ${items.length}`);

  items.forEach((m, i) => {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    const { id, label } = EXPECTED[i];
    assert.ok(open.includes(`id="${id}"`), `menu item ${i + 1} is not #${id} — order changed:\n${open}`);

    // The ACCESSIBLE NAME must survive. It comes from the button's text
    // content, so strip the inline <svg> and check what is left.
    const text = m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(text, label, `#${id} label drifted`);
  });
});

test('2. the grey inline descriptions are gone — markup AND the orphaned CSS rule', () => {
  assert.ok(!HTML.includes('fm-note'), 'fm-note still appears in index.html (span, CSS rule, or both)');
  const block = fileMenuBlock();
  assert.ok(!/>\s*gabung\s*</.test(block), 'the "gabung" note is still rendered in the menu');
  assert.ok(!/>\s*ganti semua\s*</.test(block), 'the "ganti semua" note is still rendered in the menu');
});

test('3. every menu item carries a non-empty title — the tooltip, and the a11y description', () => {
  const block = fileMenuBlock();
  for (const { id } of EXPECTED) {
    const open = block.slice(block.indexOf(`id="${id}"`));
    const tag = open.slice(0, open.indexOf('>') + 1);
    const title = /\btitle="([^"]+)"/.exec(tag);
    assert.ok(title, `#${id} has no title= — the tooltip IS the explanation now, per N2(b)`);
    assert.ok(title[1].trim().length >= 5, `#${id} title is too short to explain anything: "${title[1]}"`);
    // A title must never become the accessible NAME by displacing the text.
    assert.ok(!tag.includes('aria-label'), `#${id} gained an aria-label; it would override the visible label`);
  }
});

test('4. the toolbar Halaman button SURVIVES — his N2(a) ruling, in a test', () => {
  assert.ok(/<button[^>]*id="btn-pages"/.test(HTML), 'the toolbar #btn-pages is gone; N2(a) says it stays');
  // From past the open tag, so the attributes are not mistaken for text.
  const at = HTML.indexOf('id="btn-pages"');
  const btn = HTML.slice(HTML.indexOf('>', at) + 1);
  const label = btn.slice(0, btn.indexOf('</button>')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(label, 'Halaman', 'the toolbar button lost its label');
  assert.ok(/id="btn-pages"[\s\S]{0,400}?aria-label="Kelola halaman/.test(HTML), 'btn-pages lost its aria-label');
});

/*
 * ⚠️ AND IT RUNS OVER THE GENERATED PAGES TOO — same reason head-tags.test.mjs
 * does. The editor ships on all thirteen surfaces, they are regenerated FROM
 * index.html, and a generator that silently skipped the header would leave
 * twelve of thirteen users looking at the old two-item menu while the landing
 * looked correct. `npm run seo:check` catches staleness; it does not describe
 * WHAT should be there.
 */
test('5. all thirteen surfaces carry the same three-item menu', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo/pages.json'), 'utf8'))
    .pages.map((p) => `${p.slug}.html`);
  assert.equal(pages.length, 12, `expected 12 generated pages, got ${pages.length} — vacuity guard`);

  const wrong = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    if (html.includes('fm-note')) wrong.push(`${page} → fm-note survives`);
    for (const { id, label } of EXPECTED) {
      if (!html.includes(`id="${id}"`)) wrong.push(`${page} → missing #${id}`);
      if (!html.includes(label)) wrong.push(`${page} → missing label "${label}"`);
    }
    if (!/id="fm-pages"[^>]*\btitle="[^"]+"/.test(html)) wrong.push(`${page} → #fm-pages has no tooltip`);
  }
  assert.deepEqual(wrong, [], `generated pages drifted from index.html:\n${wrong.join('\n')}`);
});

test('6. ONE opener, two callers — the File-menu route is not a second implementation', () => {
  // The whole risk of "add a second way in" is that it becomes a second way in
  // AND a second copy of the behaviour, at which point the telemetry counts one
  // route and not the other.
  const decls = [...APP_CODE.matchAll(/function openPagesSheet\s*\(/g)];
  assert.equal(decls.length, 1, `openPagesSheet declared ${decls.length} times; it must be exactly one`);

  // `pages_open` is emitted from that one function and nowhere else.
  const tels = [...APP_CODE.matchAll(/action:\s*'pages_open'/g)];
  assert.equal(tels.length, 1, `pages_open fired from ${tels.length} places; the second is a copy`);
  const declAt = APP_CODE.indexOf('function openPagesSheet');
  const bodyEnd = APP_CODE.indexOf('\n}', declAt);
  const body = APP_CODE.slice(declAt, bodyEnd);
  assert.ok(body.includes('pageManager.open()'), 'openPagesSheet no longer opens the sheet');
  assert.ok(body.includes("action: 'pages_open'"), 'the tel() moved out of the shared opener');

  // Both button routes go through it.
  assert.ok(
    /getElementById\('btn-pages'\)\.addEventListener\('click',\s*openPagesSheet\s*\)/.test(APP_CODE),
    'the toolbar button no longer routes through openPagesSheet',
  );
  const fmStart = APP_CODE.indexOf("getElementById('fm-pages')");
  assert.ok(fmStart !== -1, 'nothing is wired to #fm-pages — the menu item is dead');
  const fmHandler = APP_CODE.slice(fmStart, APP_CODE.indexOf('\n});', fmStart));
  assert.ok(fmHandler.includes('openPagesSheet()'), '#fm-pages does not call the shared opener');
  assert.ok(
    !fmHandler.includes('pageManager.open'),
    '#fm-pages opens the sheet itself instead of calling openPagesSheet — that is the duplication this test exists to catch',
  );
  assert.ok(fmHandler.includes('toggleFileMenu(false)'), '#fm-pages leaves the dropdown open behind the sheet');
});
