#!/usr/bin/env node
/*
 * PDFLokal — scripts/gen-seo-pages.js  (SEO LANDING PAGE GENERATOR)
 * ============================================================================
 * Reads seo/pages.json + index.html (the template) and writes one static HTML
 * page per tool, plus sitemap.xml. Run it with `npm run seo`.
 *
 * WHY A GENERATOR AND NOT A BUILD STEP (decided Jul 12 2026):
 *   This script COMMITS its output. Vercel serves the generated .html files as
 *   plain static files; nothing is transformed at deploy time; if this script is
 *   never run again, the site still works. That is the whole distinction — a code
 *   generator is not a build pipeline. It preserves every property that
 *   docs/strengths.md exists to protect: the file you read is the file that
 *   ships, there is no bundler between source and browser, and any future Claude
 *   can open gabung-pdf.html and see exactly what a user sees.
 *
 *   A real SSG (Astro/Next) would also MINIFY what ships — and pdflokal.id
 *   serving readable, auditable source to every visitor is not an accident, it's
 *   the thing that makes "file kamu tidak pernah diupload" believable. We are not
 *   trading that away for templating.
 *
 * WHY index.html IS THE TEMPLATE (rather than a separate layout file):
 *   The tool page IS the app — dropzone above the fold, content below (the
 *   archetype every ranking competitor uses). Templating from index.html means a
 *   change to the editor shell can never leave the tool pages behind. The cost is
 *   that you must re-run this after touching index.html; `npm run seo:check`
 *   fails CI if you forget.
 *
 * WHAT WE DELIBERATELY DO NOT EMIT:
 *   - HowTo schema  — Google deprecated HowTo rich results (2023). Dead weight.
 *   - FAQPage schema — restricted to gov/health sites since 2023. Dead weight.
 *   - AggregateRating — we have no genuine user ratings. Competitors show stars;
 *     fabricating them is self-serving review markup, it is penalised, and it is
 *     trivially checkable. We will earn them or go without.
 *   We still WRITE the how-to steps and the FAQ as real copy — they're the word
 *   count and they genuinely help the reader. We just don't lie about them in
 *   structured data.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ===========================================================================
 * THE TASTE LOCK  (--sample / --approve)
 * ===========================================================================
 * WHY (the scar, Jul 12 2026):
 *   Fauzan looked at a generated page for NINETY SECONDS and produced two
 *   corrections nobody else could have: an h1 rewrite, and "orang yang masuk ke
 *   /pisah-pdf pasti mau pisah, tapi wording-nya nggak ngasih tau." Both were pure
 *   taste. Both were sitting ONE `npm run seo` away from hardening into TWELVE
 *   production pages — and no test on earth would have caught them, because the
 *   pages were CORRECT. They were just written in the wrong language for the user.
 *
 *   This script is a 12x MULTIPLIER, and nothing could stop it firing.
 *
 * WHAT THIS DOES: `npm run seo` now REFUSES to generate when the copy
 * (seo/pages.json) has changed and no human has looked at a rendered page since.
 *   1. edit seo/pages.json
 *   2. `npm run seo`            -> REFUSED, tells you to sample
 *   3. `npm run seo:sample -- <slug>` -> renders ONE page, drops a PNG on the desk
 *   4. a human LOOKS at it, then `npm run seo:approve`
 *   5. `npm run seo`            -> proceeds
 *
 * IT CAN ONLY REFUSE. It cannot alter a single byte of what a user sees — which is
 * precisely what makes it PM-plane tooling rather than a product change (spec §10b).
 *
 * The sample RENDERS, it does not describe. Showing Fauzan `seo/pages.json` would
 * not have worked: he did not read the JSON, he LOOKED at a page. Taste does not
 * fire on descriptions. It is also why the sample must be screenshotted through a
 * real HTTP server — the intent copy ("Seret PDF yang mau dipisah") is applied by
 * JS at runtime, so a file:// render would show the generic copy and hide the very
 * thing being reviewed.
 *
 * Screenshots go through the Playwright CLI, NEVER Playwright MCP: the MCP
 * silently redirects out-of-root writes into the REPO ROOT and misreports the path,
 * and this repo is PUBLIC. (Verified Jul 12, probe P4. See EXCEPTIONS.md rule 5.)
 * =========================================================================== */
const LOCK = join(ROOT, 'seo/.taste-lock');
const DESK = join(process.env.HOME, 'machine/work/pdflokal/taste/pending');

const copyHash = () => createHash('sha256')
  .update(readFileSync(join(ROOT, 'seo/pages.json')))
  .digest('hex').slice(0, 16);

const approvedHash = () => (existsSync(LOCK) ? readFileSync(LOCK, 'utf8').trim().split(/\s+/)[0] : null);

function approve() {
  const h = copyHash();
  writeFileSync(LOCK, `${h}\n# approved by a human who LOOKED at a rendered page.\n# Regenerate the lock with: npm run seo:approve\n`);
  console.log(`  ✅ copy approved (${h}). \`npm run seo\` will now generate all pages.`);
  process.exit(0);
}

// Serve the repo statically for the screenshot. Node stdlib, no npx serve — which
// caches aggressively and would happily screenshot a stale page.
function serve(port) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (!extname(p)) p += '.html'; // cleanUrls, same as Vercel
    const abs = join(ROOT, p);
    if (!abs.startsWith(ROOT) || !existsSync(abs)) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(abs));
  });
  // Resolve only once it is ACTUALLY listening — firing the screenshot against a
  // socket that isn't up yet is a race, and a race in a safety lock is worthless.
  return new Promise((res) => { srv.listen(port, () => res(srv)); });
}

async function sample(slug) {
  const pages = JSON.parse(readFileSync(join(ROOT, 'seo/pages.json'), 'utf8')).pages;
  const page = pages.find((p) => p.slug === slug);
  if (!page) {
    console.error(`  ✖ no page "${slug}". Available:\n${pages.map((p) => `      ${p.slug}`).join('\n')}`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, `${slug}.html`))) {
    console.error(`  ✖ ${slug}.html does not exist yet. This samples a RENDERED page, so generate once first.`);
    process.exit(1);
  }

  mkdirSync(DESK, { recursive: true });
  const out = join(DESK, `${slug}.png`);
  const port = 4197;
  const srv = await serve(port);
  try {
    // THE PATH, NOT THE PAGE. (Ratified law, and it is filed against ME.)
    //
    // My first version screenshotted the landing page — and would have MISSED the
    // very defect that motivated it. Fauzan caught "Ekstrak" on /pisah-pdf, but
    // that word is not ON the landing page: it lives on a button inside the Kelola
    // Halaman sheet, which only exists AFTER a file is dropped. He found it by
    // WALKING THE PATH: arrive → drop a file → read the sheet. Every string was
    // correct in isolation; the defect was distributed across the journey.
    //
    // So the sample is a SEQUENCE: arrival → after the drop → where the intent
    // lands. If a defect can hide between two frames, one frame is not a sample.
    //
    // A script, not the `playwright screenshot` CLI, because the CLI cannot drop a
    // file. Still NOT Playwright MCP — that writes into the repo root and lies
    // about the path (EXCEPTIONS.md rule 5).
    await new Promise((res, rej) => {
      const ch = spawn('node', ['scripts/sample-path.mjs', slug, String(port), out], {
        cwd: ROOT, stdio: 'inherit', timeout: 120_000,
      });
      ch.on('error', rej);
      ch.on('exit', (code) => (code === 0 ? res() : rej(new Error(`sample-path exited ${code}`))));
    });
  } finally {
    srv.close();
  }
  if (!existsSync(out)) {
    console.error('  ✖ the screenshot did not land. Refusing to claim a sample exists.');
    process.exit(1);
  }

  console.log(`\n  📄 TASTE SAMPLE — 1 of ${pages.length}\n`);
  console.log(`     ${out}`);
  console.log(`\n     h1:       ${page.h1}`);
  console.log(`     sub:      ${page.sub}`);
  console.log(`     intent:   ${page.intent}${page.target ? ` (target ${Math.round(page.target / 1024)} KB)` : ''}`);
  console.log(`\n     LOOK AT THE PNG. Not the JSON — the JSON is where the last two`);
  console.log(`     taste errors hid in plain sight and passed every test.`);
  console.log(`\n     Then: npm run seo:approve\n`);
}

const SAMPLE_I = process.argv.indexOf('--sample');
if (process.argv.includes('--approve')) approve();
if (SAMPLE_I !== -1) {
  await sample(process.argv[SAMPLE_I + 1]);
  process.exit(0);
}

// --check: regenerate in memory and compare against what is on disk. Exits 1 on
// any difference. Deliberately does NOT shell out to `git diff` — that compares
// the working tree to HEAD, so it fires on ANY uncommitted work, not on actual
// drift. A check that cries wolf is a check someone disables. This one only fails
// when a generated page genuinely disagrees with seo/pages.json + index.html.
const CHECK = process.argv.includes('--check');
const drift = [];

// THE LOCK. Deliberately does NOT apply to --check: that path only READS and
// compares, it writes nothing, and CI runs it. A safety lock that breaks CI is a
// safety lock someone deletes — the same disease as a check that cries wolf.
if (!CHECK) {
  const now = copyHash();
  const ok = approvedHash();
  if (ok !== now) {
    console.error('\n  🔒 REFUSING TO GENERATE — the copy changed and nobody has LOOKED at it.\n');
    console.error(`     seo/pages.json  ${now}`);
    console.error(`     last approved   ${ok ?? '(never)'}\n`);
    console.error('     This script writes 12 pages at once. On Jul 12 a wording error sat ONE run');
    console.error('     away from hardening into all twelve — and no test would have caught it,');
    console.error('     because the pages were CORRECT, just written in the wrong language for the');
    console.error('     user. Fauzan found it in ninety seconds BY LOOKING at a rendered page.\n');
    console.error('     Render one, look at it, then approve:');
    console.error('       npm run seo:sample -- kompres-pdf');
    console.error('       npm run seo:approve\n');
    process.exit(1);
  }
}

function emit(relPath, content) {
  const abs = join(ROOT, relPath);
  if (CHECK) {
    const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (onDisk !== content) drift.push(relPath);
    return;
  }
  writeFileSync(abs, content);
}
const data = JSON.parse(readFileSync(join(ROOT, 'seo/pages.json'), 'utf8'));
const template = readFileSync(join(ROOT, 'index.html'), 'utf8');
const { origin, brand } = data.site;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Replace exactly once, and SHOUT if the anchor vanished. A silent no-op here
// would ship a page with the homepage's <title> — the single worst failure mode
// this script has, and one no test would notice.
function sub(html, re, replacement, label) {
  if (!re.test(html)) throw new Error(`gen-seo-pages: anchor not found in index.html: ${label}. The template changed — fix the regex, don't ship a page with the homepage's ${label}.`);
  return html.replace(re, () => replacement);
}

function copyBlock(page) {
  const parts = [`<p>${page.intro}</p>`];
  // `howto` is written out longhand in pages.json, NOT derived from the h1. Deriving
  // it gave "Cara kompres pdf biar lolos batas upload" — lowercased PDF, clumsy
  // Indonesian. It also happens to be a real query shape ("cara kompres pdf"), so
  // it's worth writing by hand rather than generating badly.
  if (!page.howto) throw new Error(`gen-seo-pages: ${page.slug} has no "howto" heading`);
  parts.push(`<h2>${esc(page.howto)}</h2>`);
  parts.push('<ol>');
  for (const s of page.steps) parts.push(`<li>${s}</li>`);
  parts.push('</ol>');
  for (const sec of page.sections) {
    parts.push(`<h2>${sec.h2}</h2>`);
    for (const p of sec.p) parts.push(`<p>${p}</p>`);
  }
  return `<div class="ld-copy">\n          ${parts.join('\n          ')}\n        </div>`;
}

function faqBlock(page) {
  const items = page.faq
    .map((f) => `<details>\n            <summary>${esc(f.q)}</summary>\n            <p>${esc(f.a)}</p>\n          </details>`)
    .join('\n          ');
  return `<section class="ld-faq">\n          <h2>Sering ditanya</h2>\n          ${items}\n        </section>`;
}

function schema(page, url) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: `${page.h1} — ${brand}`,
        url,
        description: page.description,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Chrome, Firefox, Safari, Edge',
        browserRequirements: 'Requires JavaScript',
        inLanguage: 'id-ID',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'IDR' },
        publisher: { '@type': 'Organization', name: brand, url: `${origin}/` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: brand, item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: page.h1, item: url },
        ],
      },
    ],
  }, null, 2);
}

const banner = `<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: seo/pages.json (copy) + index.html (the app shell template).
     Regenerate with: npm run seo
     Hand edits are destroyed on the next run, and "npm run seo:check" fails CI. -->\n`;

const written = [];

for (const page of data.pages) {
  const url = `${origin}/${page.slug}`;
  let html = template;

  html = sub(html, /<title>[\s\S]*?<\/title>/, `<title>${esc(page.title)}</title>`, '<title>');
  html = sub(html, /<meta name="description"[\s\S]*?>/, `<meta name="description" content="${esc(page.description)}">`, 'meta description');
  html = sub(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, 'canonical');
  html = sub(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(page.title)}">`, 'og:title');
  html = sub(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(page.description)}">`, 'og:description');
  html = sub(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, 'og:url');
  html = sub(html, /<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(page.title)}">`, 'twitter:title');
  html = sub(html, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(page.description)}">`, 'twitter:description');
  html = sub(html, /<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">\n${schema(page, url)}\n</script>`, 'JSON-LD');

  // The intent hook: app.js reads document.body.dataset.intent, so landing on
  // /kompres-pdf and dropping a file opens the compress sheet with no click.
  // NOTE: append the attribute, never rebuild the tag — index.html's <body> carries
  // class="is-empty", which the landing state depends on. (An earlier version of
  // this line clobbered the whole tag. The pages still RENDERED, because browsers
  // synthesise a missing <body> — so nothing looked broken. Only the intent test
  // caught it. Assume a template edit here fails silently.)
  const bodyTag = html.match(/<body(\s[^>]*)?>/);
  if (!bodyTag) throw new Error('gen-seo-pages: no <body> tag in index.html');
  if (bodyTag[0].includes('data-intent')) throw new Error('gen-seo-pages: index.html already declares data-intent — the template must stay intent-free');
  // data-target: the hard size cap for /kompres-pdf-500kb and friends. This is the
  // ONLY reason those pages are allowed to exist — they change what the tool DOES.
  // download-sheet validates the number against its own TARGETS list, so a bad
  // value degrades to "Otomatis" rather than becoming a bogus cap.
  const attrs = ` data-intent="${page.intent}"${page.target ? ` data-target="${page.target}"` : ''}`;
  html = html.replace(bodyTag[0], bodyTag[0].replace(/>$/, `${attrs}>`));

  html = sub(html, /<h1>[\s\S]*?<\/h1>/, `<h1>${esc(page.h1)}</h1>`, '<h1>');
  html = sub(html, /<p class="ld-sub">[\s\S]*?<\/p>/, `<p class="ld-sub">${esc(page.sub)}</p>`, '.ld-sub');

  // "Tampilan baru" means nothing to someone arriving cold from Google — it's a
  // message for returning users of the OLD site. Drop it on the tool pages.
  html = html.replace(/<div class="ld-stamp"[^>]*>[\s\S]*?<\/div>\s*/, '');

  html = sub(html, /<section class="ld-faq">[\s\S]*?<\/section>/, `${copyBlock(page)}\n        ${faqBlock(page)}`, '.ld-faq');

  emit(`${page.slug}.html`, banner + html);
  const words = [page.intro, ...page.steps, ...page.sections.flatMap((s) => s.p), ...page.faq.flatMap((f) => [f.q, f.a])]
    .join(' ').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length;
  written.push({ slug: page.slug, words, target: page.target ?? null });
  if (!CHECK) console.log(`  ✓ ${page.slug}.html  (${words} words of body copy)`);
}

// ---- sitemap ---------------------------------------------------------------
// alat-gambar.html and lab.html are absent on purpose: both are noindex.
const urls = [
  { loc: `${origin}/`, priority: '1.0', changefreq: 'weekly' },
  ...data.pages.map((p) => ({ loc: `${origin}/${p.slug}`, priority: '0.9', changefreq: 'monthly' })),
  { loc: `${origin}/privasi.html`, priority: '0.3', changefreq: 'yearly' },
  { loc: `${origin}/dukung.html`, priority: '0.3', changefreq: 'yearly' },
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by scripts/gen-seo-pages.js — do not edit by hand. Run: npm run seo
     alat-gambar.html and lab.html are deliberately absent: both are noindex. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')}
</urlset>
`;
emit('sitemap.xml', sitemap);

// TWO thresholds, because there are two different SERPs — not because the lower
// one is a convenient excuse for a thin page.
//   HEAD terms (gabung/kompres/edit…) fight iLovePDF, Smallpdf, PDF24, Adobe.
//   The ranking sites WITHOUT domain authority carry 693–925 words there.
//   LONG-TAIL size terms (kompres pdf 500kb…) fight pdf.pi7.org and
//   bigpdf.11zon.com — thin, low-authority pages. 450 clears that field.
// If you find yourself padding a page to beat a number, you have misunderstood
// this check: it exists to stop us shipping a page too thin to compete, not to
// be satisfied with filler. Filler is how a page cluster becomes a doorway farm.
const FLOOR_HEAD = 550;
const FLOOR_TAIL = 450;
const thin = written.filter((w) => w.words < (w.target ? FLOOR_TAIL : FLOOR_HEAD));
if (!CHECK) console.log(`  ✓ sitemap.xml (${urls.length} URLs)`);
if (thin.length && !CHECK) {
  console.log(`\n  ⚠️  THIN PAGES: ${thin.map((t) => `${t.slug} (${t.words}w, floor ${t.target ? FLOOR_TAIL : FLOOR_HEAD})`).join(', ')}`);
  console.log('     Add real content, not filler. iLovePDF ranks #1 on 109 words — that is');
  console.log('     domain authority, and it is not a page feature we can copy.');
}

if (CHECK) {
  if (drift.length) {
    console.error('\n  ❌ SEO pages are out of date with their source:');
    for (const f of drift) console.error(`       ${f}`);
    console.error('\n     Someone hand-edited a generated file, or changed seo/pages.json /');
    console.error('     index.html without regenerating. Run:  npm run seo');
    process.exit(1);
  }
  console.log('  ✅ SEO pages match seo/pages.json + index.html');
}
