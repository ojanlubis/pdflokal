/*
 * The Indonesian detector shared by the English page specs (en-page, en-support).
 * Every visible-or-hidden text node (dialogs, folded grids, FAQ answers) and every
 * accessible-name attribute, plus the head's title and description metas, minus
 * script/style and anything inside a [lang="id"] element in the body (the
 * "Bahasa Indonesia" link; not <html lang="id">, which would exempt every word
 * on an Indonesian page). textContent semantics, not innerText: innerText skips
 * whatever is hidden, and a hidden dialog is still copy.
 *
 * `skip` is one more selector a page exempts (the work log's commit subjects on
 * /en/support). Each spec points it first at the Indonesian twin, where it must
 * find plenty: a detector that finds nothing there would pass English for free.
 */
export async function indonesianHits(page, { stop, exempt = [], skip = '' }) {
  return page.evaluate(({ stop, exempt, skip }) => {
    const re = new RegExp(stop.source, stop.flags);
    const hits = [];
    const ignore = 'script, style, body [lang="id"]' + (skip ? `, ${skip}` : '');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest(ignore)) continue;
      const text = n.textContent.replace(/\s+/g, ' ').trim();
      if (!text || exempt.includes(text)) continue;
      if (re.test(text)) hits.push(`text: ${text}`);
    }
    for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
      if (el.closest('body [lang="id"]')) continue;
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) hits.push(`${a}: ${v}`);
      }
    }
    for (const sel of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]']) {
      const v = document.querySelector(sel)?.getAttribute('content');
      if (v && re.test(v)) hits.push(`${sel}: ${v}`);
    }
    if (re.test(document.title)) hits.push(`title: ${document.title}`);
    return hits;
  }, { stop: { source: stop.source, flags: stop.flags }, exempt, skip });
}
