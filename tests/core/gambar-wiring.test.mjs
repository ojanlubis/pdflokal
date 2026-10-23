/*
 * GAMBAR: THE WIRING THAT CANNOT BE SEEN FROM A UNIT
 * ============================================================================
 * Source-level guards (the app shell has no headless harness), each shown a
 * known-positive so a pattern that matches nothing cannot pass for free:
 *   - the picture never leaves the tab: image-decode.js and the Gambar blocks
 *     of app.js make no network call (privacy is the product);
 *   - every telemetry call Gambar makes is a value the shared schema accepts
 *     (api/t.js drops off-schema events silently, so a typo would be invisible);
 *   - the placement actions count as an edit for the bug-report prompt;
 *   - the tool is armed from the toolbar, placed by the interaction layer, and
 *     its picker is its own input, never the document opener.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvent } from '../../js/core/telemetry-schema.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('js/v2/app.js');
const DECODE = read('js/v2/image-decode.js');
const INTERACTION = read('js/render/interaction.js');
const INDEX = read('index.html');

const NETWORK = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/;

test('the decoder makes no network call (and the detector sees one when there is one)', () => {
  assert.ok(NETWORK.test('await fetch(url)'), 'known-positive');
  assert.ok(!NETWORK.test(DECODE.replace(/\/\*[\s\S]*?\*\//g, '')), 'image-decode.js is network-free');
});

test('the Gambar blocks of app.js make no network call', () => {
  const a = APP.indexOf('async function pasteImageFile');
  const b = APP.indexOf('// Plain text becomes a text object');
  assert.ok(a > 0 && b > a, 'found the paste/picker block');
  const block = APP.slice(a, b).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!NETWORK.test(block));
  const placing = APP.slice(APP.indexOf("} else if (t === 'gambar' && pendingGambar)"), APP.indexOf('onDrawStart'));
  assert.ok(placing.length > 100 && !NETWORK.test(placing));
});

test("every tel('tool_use', {tool: 'gambar', action}) in app.js validates against the shared schema", () => {
  const calls = [...APP.matchAll(/tel\('tool_use', \{ tool: 'gambar', action: '(\w+)' \}\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['image', 'image_paste'], 'the two placement paths, once each');
  for (const action of calls) assert.equal(validateEvent('tool_use', { tool: 'gambar', action }).ok, true, action);
  // 'arm' goes through ARM_TOOL, the one place data-tool maps to the rail's word.
  assert.match(APP, /const ARM_TOOL = \{[^}]*gambar: 'gambar'[^}]*\}/);
  assert.equal(validateEvent('tool_use', { tool: 'gambar', action: 'arm' }).ok, true);
});

test('a placed picture counts as a committed edit for the bug-report prompt', () => {
  const m = APP.match(/const COMMIT_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'found COMMIT_ACTIONS');
  assert.ok(m[1].includes("'image'") && m[1].includes("'image_paste'"));
  assert.ok(!m[1].includes("'arm'"), 'arming alone is not an edit');
});

test('the toolbar arms it, the interaction layer places it, and the picker is its own input', () => {
  assert.match(INDEX, /<button class="tool" data-tool="gambar"/);
  assert.match(INDEX, /<input type="file" id="gambar-file" accept="image\/\*" hidden>/);
  assert.match(INTERACTION, /tool === 'gambar'/);
  assert.match(APP, /if \(t === 'gambar'\) \{ gambarInput\.click\(\); return; \}/);
  assert.match(APP, /document\.getElementById\('gambar-file'\)/);
  assert.ok(!/id="file-input"[^>]*data-tool/.test(INDEX));
});

test("a tool returns home after its verb: the tap places, then setTool('select'); setTool drops the picture", () => {
  const placing = APP.slice(APP.indexOf("} else if (t === 'gambar' && pendingGambar)"), APP.indexOf('onDrawStart'));
  assert.match(placing, /setTool\('select'\)/);
  assert.match(APP, /if \(next !== 'gambar'\) pendingGambar = null;/);
});

test('the toolbar words come from DRAFT locale keys, with no hard-coded label in the markup', () => {
  assert.match(INDEX, /<span data-gambar-label><\/span>/);
  assert.match(APP, /tr\('tools\.gambar'\)/);
  assert.match(APP, /tr\('tools\.gambarTip'\)/);
  for (const f of ['js/locales/id.js', 'js/locales/en.js']) {
    const src = read(f);
    assert.match(src, /gambar: '[^']+', \/\/ DRAFT/, `${f} marks tools.gambar DRAFT`);
    assert.match(src, /gambarTip: '[^']+', \/\/ DRAFT/, `${f} marks tools.gambarTip DRAFT`);
  }
});
