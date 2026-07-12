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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --check: regenerate in memory and compare against what is on disk. Exits 1 on
// any difference. Deliberately does NOT shell out to `git diff` — that compares
// the working tree to HEAD, so it fires on ANY uncommitted work, not on actual
// drift. A check that cries wolf is a check someone disables. This one only fails
// when a generated page genuinely disagrees with seo/pages.json + index.html.
const CHECK = process.argv.includes('--check');
const drift = [];

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
