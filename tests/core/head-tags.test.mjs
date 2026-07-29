/*
 * THE MACHINE-READABLE HEAD SURVIVES EVERY VISUAL SIMPLIFICATION.
 * ============================================================================
 * specs/design-system.md §6b, his own guard: "a simple design doesn't need to
 * mean bad SEO. we can still use meta tags, schema, llm.txt, etc."
 *
 * ⚠️ THE RISK IS REAL AND IT IS SPECIFIC TO THIS REDESIGN. The brief said
 * "subtraction beats softening" and ruled visible copy away — the H1 subhead,
 * the "Mau ngapain hari ini?" label. Over-applied one layer down, that same
 * instinct eats the head, and NOTHING ELSE IN THE GATE WOULD NOTICE: the page
 * renders identically, every Playwright assertion still passes, and the loss
 * shows up weeks later as traffic.
 *
 * The rule that settles it is about ORDER, not volume: content above the answer
 * is theft, content below it is free — and the head is not in the visual flow at
 * all, so it is free by construction. A visual simplification may never remove a
 * machine-readable claim. If the head loses a tag, that is a REGRESSION.
 *
 * ⚠️ WHY THIS ASSERTS KEYS AND NOT A COUNT. A count is the cheap version and it
 * is one level too shallow — the same mistake shape as "read the bytes". Renaming
 * og:title to og:headline keeps the count at nine and breaks every share card.
 * So the required KEYS are named, and the count is a floor on top of that.
 *
 * ⚠️ AND IT RUNS OVER THE GENERATED PAGES TOO. They are 12/13 of the indexed
 * surface, they are regenerated from index.html, and a generator bug has already
 * blanked all twelve of them once in this repo. Checking only the landing would
 * check the smallest part of the exposure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGES = ['index.html', ...JSON.parse(fs.readFileSync(path.join(ROOT, 'seo/pages.json'), 'utf8'))
  .pages.map((p) => `${p.slug}.html`)];

const REQUIRED_OG = [
  'og:title', 'og:description', 'og:url', 'og:image',
  'og:image:width', 'og:image:height', 'og:type', 'og:locale',
];
const REQUIRED_TWITTER = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
/*
 * ⚠️ TWO SURFACES, TWO SCHEMAS, AND THAT IS DELIBERATE — not drift.
 * The landing is the app itself: WebApplication, with an ImageObject for the
 * share card. A tool page is a SoftwareApplication sitting inside a
 * BreadcrumbList, because it has a place in a hierarchy that the landing does
 * not. The first version of this test demanded the landing's four types
 * everywhere and flagged twelve correct pages as regressions.
 *
 * Both lists carry Organization and Offer: who makes it, and that it is free.
 * Those two are the claims we would actually lose sleep over.
 */
const REQUIRED_LD_TYPES = {
  landing: ['WebApplication', 'Organization', 'Offer', 'ImageObject'],
  tool: ['SoftwareApplication', 'Organization', 'Offer', 'BreadcrumbList'],
};

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const head = (html) => {
  const end = html.indexOf('</head>');
  assert.ok(end !== -1, 'no </head> — the document is not a page');
  return html.slice(0, end);
};

test('1. every indexed page keeps its Open Graph and Twitter cards', () => {
  // VACUITY GUARD: if the page list were empty this whole test would pass
  // having checked nothing — the exact shape the audit calls Class 5.
  assert.equal(PAGES.length, 13, `expected 13 indexed pages (landing + 12), got ${PAGES.length}`);

  const missing = [];
  for (const page of PAGES) {
    const h = head(read(page));
    for (const key of REQUIRED_OG) {
      if (!h.includes(`property="${key}"`)) missing.push(`${page} → ${key}`);
    }
    for (const key of REQUIRED_TWITTER) {
      if (!h.includes(`name="${key}"`)) missing.push(`${page} → ${key}`);
    }
    if (!/<link rel="canonical" href="[^"]+"/.test(h)) missing.push(`${page} → canonical`);
    // ⚠️ [\s\S] not [^"]: index.html's meta description is wrapped across two
    // lines. A single-line regex reported the landing as having lost its
    // description while it was sitting right there — the test would have been
    // "fixed" by deleting the assertion.
    if (!/<meta name="description"[\s\S]{0,40}content="[^"]+"/.test(h)) missing.push(`${page} → meta description`);
    if (!/<title>[^<]+<\/title>/.test(h)) missing.push(`${page} → title`);
  }

  assert.deepEqual(
    missing, [],
    `machine-readable tags were removed:\n  ${missing.join('\n  ')}\n\n`
    + 'A visual simplification may never remove a machine-readable claim (specs/design-system.md §6b). '
    + 'The head is not in the visual flow, so nothing there competes for a reader\'s attention and '
    + 'nothing there is a candidate for subtraction.',
  );
});

test('2. the structured data still parses and still carries all four types', () => {
  const failures = [];
  for (const page of PAGES) {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head(read(page)));
    if (!m) { failures.push(`${page}: no ld+json block at all`); continue; }

    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (err) {
      // A block that is present but INVALID is worse than absent: it looks
      // right in a diff and Google discards it silently.
      failures.push(`${page}: ld+json does not parse — ${err.message}`);
      continue;
    }

    const types = JSON.stringify(parsed).match(/"@type":"([A-Za-z]+)"/g) || [];
    assert.ok(types.length, `${page}: ld+json parsed to something with no @type at all`);
    const want = page === 'index.html' ? REQUIRED_LD_TYPES.landing : REQUIRED_LD_TYPES.tool;
    for (const t of want) {
      if (!types.some((x) => x.includes(`"${t}"`))) failures.push(`${page}: ld+json lost @type ${t}`);
    }
  }
  assert.deepEqual(failures, [], `structured data regressed:\n  ${failures.join('\n  ')}`);
});

test('3. the crawler-facing files at the root still exist and are not empty', () => {
  // ⚠️ manifest.webmanifest, NOT manifest.json. The design system's prose says
  // "manifest.json"; the file on disk and the <link rel="manifest"> both say
  // .webmanifest. Asserting the documented name would have failed a correct
  // repo — so this asserts what the PAGE actually links to.
  const linked = /<link rel="manifest" href="\/([^"]+)"/.exec(read('index.html'));
  assert.ok(linked, 'index.html no longer links a web app manifest — the PWA stops being installable');

  for (const f of ['robots.txt', 'sitemap.xml', 'humans.txt', linked[1]]) {
    const abs = path.join(ROOT, f);
    assert.ok(fs.existsSync(abs), `${f} is missing from the repo root`);
    assert.ok(fs.statSync(abs).size > 0, `${f} exists but is EMPTY, which is the same as missing to a crawler`);
  }

  // The sitemap must actually list the pages, not just exist.
  const sitemap = read('sitemap.xml');
  const urls = (sitemap.match(/<loc>/g) || []).length;
  assert.ok(
    urls >= PAGES.length,
    `sitemap.xml lists ${urls} URLs but there are ${PAGES.length} indexed pages. Run \`npm run seo\`.`,
  );
});

test('4. the landing has NOT been stripped relative to a generated page', () => {
  /*
   * The cross-check that catches a one-sided edit. The landing and the tool
   * pages come from the same template, so their head SHAPES must match even
   * though their values differ. If someone tidies index.html's head by hand,
   * this goes red without anyone having to know which tag was lost.
   */
  const shape = (f) => {
    const h = head(read(f));
    return {
      og: (h.match(/property="og:[a-z:]+"/g) || []).sort(),
      tw: (h.match(/name="twitter:[a-z:]+"/g) || []).sort(),
      meta: (h.match(/<meta /g) || []).length,
    };
  };
  const landing = shape('index.html');
  const generated = shape('kompres-pdf.html');

  assert.ok(landing.og.length >= 8, `the landing has only ${landing.og.length} og: tags — the matcher is broken`);
  assert.deepEqual(landing.og, generated.og, 'the landing and the generated pages no longer carry the same og: tags');
  assert.deepEqual(landing.tw, generated.tw, 'the landing and the generated pages no longer carry the same twitter: tags');
  assert.equal(
    landing.meta, generated.meta,
    `the landing has ${landing.meta} <meta> tags and kompres-pdf.html has ${generated.meta}. `
    + 'They are generated from the same template, so a difference means one of them was edited by hand.',
  );
});
