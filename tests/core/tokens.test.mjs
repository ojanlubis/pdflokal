/*
 * THE TOKENS ARE THE DESIGN SYSTEM. This proves they still are.
 * ============================================================================
 * ../specs/design-system.md §8 item 6 asks for "a lint that fails on a raw px
 * value in a component", with the reason stated plainly: "without it this
 * document is decoration within a month, and a rule nobody checks is a green
 * check that cannot go red."
 *
 * ⚠️ EVERY ASSERTION HERE IS COMPUTED, NOT TRANSCRIBED. A test that re-types
 * `--fs-9: 82.6px` and checks the file says `82.6px` proves only that two
 * copies of a number agree — it would pass just as happily if the whole scale
 * had been invented. So the scale is RECOMPUTED from base 16 x ratio 1.2, and
 * the dark accent's contrast is RECOMPUTED from the sRGB values. Those can go
 * red on a real mistake; a string comparison cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = fs.readFileSync(path.join(ROOT, 'css/tokens.css'), 'utf8');

// Strip comments first — several carry hex values and px numbers inside prose,
// and a parser that reads those finds tokens that do not exist.
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/*
 * Every `--name: value;` declared inside EVERY block this selector opens.
 *
 * ⚠️ It merges across all matches on purpose. `:root` is legitimately written
 * more than once — the dark palette is declared next to the dark rules that use
 * it, where it can be read, rather than a hundred lines away in the light
 * block. A parser that stopped at the first match reported `--d-accent` as
 * missing and failed two tests for a reason that had nothing to do with the CSS.
 */
function block(selectorRe) {
  const re = new RegExp(selectorRe.source, `${selectorRe.flags.replace(/g/, '')}g`);
  const out = new Map();
  let found = 0;
  for (const m of CODE.matchAll(re)) {
    found++;
    const open = CODE.indexOf('{', m.index);
    let depth = 0; let i = open;
    for (; i < CODE.length; i++) {
      if (CODE[i] === '{') depth++;
      else if (CODE[i] === '}' && --depth === 0) break;
    }
    for (const d of CODE.slice(open + 1, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(d[1], d[2].trim());
    }
  }
  assert.ok(found > 0, `tokens.css no longer contains a block matching ${selectorRe}`);
  return out;
}

test('1. the type scale really is ratio 1.2 from base 16 — recomputed, not restated', () => {
  const light = block(/^:root\s*\{/m);
  assert.ok(light.size >= 25, `parsed only ${light.size} tokens from :root — the parser is broken`);

  // step -2 .. 9. Step 10 (99px) is deliberately RESERVED and must stay absent:
  // a token that exists gets used, and nothing on this product earns it yet.
  const steps = [['--fs-n2', -2], ['--fs-n1', -1], ['--fs-0', 0], ['--fs-1', 1],
    ['--fs-2', 2], ['--fs-3', 3], ['--fs-4', 4], ['--fs-5', 5], ['--fs-6', 6],
    ['--fs-7', 7], ['--fs-8', 8], ['--fs-9', 9]];

  const wrong = [];
  for (const [name, n] of steps) {
    const raw = light.get(name);
    assert.ok(raw, `${name} is missing from tokens.css`);
    const got = parseFloat(raw);
    const want = 16 * 1.2 ** n;
    // Half a pixel: the published scale is rounded for legibility (82.56 ->
    // 82.6, 23.03 -> 23), and rounding is fine. Inventing a size is not.
    if (Math.abs(got - want) > 0.5) {
      wrong.push(`${name}: ${got}px, but 16 x 1.2^${n} = ${want.toFixed(2)}px`);
    }
  }
  assert.deepEqual(wrong, [],
    `these sizes are off the scale, which means a future page can no longer "pick a step":\n  ${wrong.join('\n  ')}`);

  assert.equal(light.has('--fs-10'), false,
    '--fs-10 (99px) was added. The spec reserves it: "nothing yet earns it". '
    + 'A token that exists gets used — take this to Fauzan before shipping it.');
});

test('2. spacing tokens are all on the base-4 ramp', () => {
  const light = block(/^:root\s*\{/m);
  const RAMP = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
  const sp = [...light].filter(([k]) => k.startsWith('--sp-'));
  assert.equal(sp.length, RAMP.length, `expected ${RAMP.length} spacing tokens, found ${sp.length}`);
  for (const [name, value] of sp) {
    const px = parseFloat(value);
    assert.ok(RAMP.includes(px), `${name} is ${px}px, which is not on the ramp ${RAMP.join(' · ')}`);
    // The name must equal the value, or `var(--sp-24)` stops reading at the
    // call site and every use needs a lookup.
    assert.equal(px, Number(name.slice('--sp-'.length)), `${name} does not equal its own value (${px}px)`);
  }
});

test('3. an explicit theme choice wins in BOTH directions', () => {
  // The usual way this ships broken: dark written ONLY as a media query, so a
  // user who chose light on a dark-set OS cannot turn it off.
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)/.exec(CODE);
  assert.ok(media, 'tokens.css no longer honours prefers-color-scheme at all — '
    + 'first visit would fall back to light, which is the exact defect this replaced');

  const auto = block(/:root:not\(\[data-theme="light"\]\)\s*\{/);
  const forced = block(/:root\[data-theme="dark"\]\s*\{/);

  assert.ok(auto.size >= 8, `the system-preference dark block sets only ${auto.size} tokens`);
  assert.deepEqual(
    [...forced.keys()].sort(), [...auto.keys()].sort(),
    'the two dark blocks no longer set the same tokens. Whichever one is short, that token '
    + 'keeps its LIGHT value in that state — a half-dark page that looks fine in the other state.',
  );

  // The media block must exclude an explicit light choice, or "I chose light"
  // silently loses to a dark OS.
  assert.ok(
    CODE.slice(media.index, media.index + 200).includes(':not([data-theme="light"])'),
    'the prefers-color-scheme block no longer excludes [data-theme="light"], so a user who '
    + 'explicitly chose light gets dark anyway on a dark-set OS.',
  );
});

test('4. the dark accent clears 4.5:1 on the dark ground — red is a LINK colour', () => {
  const light = block(/^:root\s*\{/m);
  const lum = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((h) => {
      const v = parseInt(h, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const accent = light.get('--d-accent');
  const bg = light.get('--d-bg');
  assert.ok(accent && bg, 'the dark palette lost --d-accent or --d-bg');

  const r = ratio(accent, bg);
  assert.ok(r >= 4.5,
    `the dark accent ${accent} on ${bg} measures ${r.toFixed(2)}:1, under the 4.5:1 floor. `
    + 'Red is THE touchable colour in this system, so it lands on links and has to stay readable. '
    + `The light accent ${light.get('--accent')} measures ${ratio(light.get('--accent'), bg).toFixed(2)}:1 `
    + 'here, which is why dark uses a lighter red rather than the same one.');

  // VACUITY GUARD: prove the metric can fail, using the value we rejected.
  // Without this, a broken `ratio()` returning Infinity would pass silently.
  assert.ok(ratio('#dc2626', '#171717') < 4.5,
    'the contrast function no longer flags the light accent on the dark ground — it measured '
    + '3.71:1 by hand, so a function that passes it is broken, not lenient.');
});

test('6. every theme state declares color-scheme — the browser repaints controls without it', () => {
  /*
   * ⚠️ THIS GUARDS A DEFECT NO COMPUTED-STYLE ASSERTION CAN SEE.
   * On 2026-07-30 the dark landing rendered its dropzone as a light grey slab
   * with unreadable hint text. `getComputedStyle(dropzone).backgroundColor`
   * returned `rgb(18, 18, 18)` — the correct token — at the same moment. The
   * page simply never declared `color-scheme`, so Chrome applied its own
   * auto-dark treatment to the <button>. Only the screenshot caught it.
   *
   * So the assertion is on the DECLARATION, which is the actual root cause and
   * the only part of this that is mechanically checkable.
   */
  const light = block(/^:root\s*\{/m);
  const auto = block(/:root:not\(\[data-theme="light"\]\)\s*\{/);
  const forced = block(/:root\[data-theme="dark"\]\s*\{/);
  void light; void auto; void forced; // parsed above only to fail loudly if the blocks vanish

  const scheme = (selectorRe) => {
    const re = new RegExp(selectorRe.source, `${selectorRe.flags.replace(/g/, '')}g`);
    for (const m of CODE.matchAll(re)) {
      const open = CODE.indexOf('{', m.index);
      let depth = 0; let i = open;
      for (; i < CODE.length; i++) {
        if (CODE[i] === '{') depth++;
        else if (CODE[i] === '}' && --depth === 0) break;
      }
      const hit = /color-scheme\s*:\s*([\w\s]+);/.exec(CODE.slice(open + 1, i));
      if (hit) return hit[1].trim();
    }
    return null;
  };

  assert.equal(scheme(/^:root\s*\{/m), 'light',
    'the light :root no longer declares color-scheme. UA-rendered surfaces (form controls, '
    + 'scrollbars) will be painted by the browser\'s own heuristics rather than by this system.');

  for (const [name, re] of [
    ['the system-preference dark block', /:root:not\(\[data-theme="light"\]\)\s*\{/],
    ['the explicit [data-theme="dark"] block', /:root\[data-theme="dark"\]\s*\{/],
  ]) {
    assert.equal(scheme(re), 'dark',
      `${name} does not declare color-scheme: dark. The dropzone is a <button>: without this it `
      + 'renders as a light grey slab on the dark page, and the computed backgroundColor still '
      + 'reads as the correct dark token, so nothing else in the suite can tell.');
  }
});

test('5. red is not quietly redefined per-mode into something that is not red', () => {
  // "Red = touchable, always, only" is the rule most likely to be broken by a
  // future page. A dark mode that swaps the accent to blue would satisfy every
  // other test in this file.
  const light = block(/^:root\s*\{/m);
  for (const name of ['--accent', '--d-accent']) {
    const hex = light.get(name).replace('#', '');
    const [r, g, b] = hex.match(/../g).map((h) => parseInt(h, 16));
    assert.ok(r > g + 60 && r > b + 60,
      `${name} is #${hex}, which is not a red. The one grammar law is "red means touchable, `
      + 'and it has no other job" — changing the hue changes what every control in the product means.');
  }
});
