/*
 * PDFLokal — core/page-fence.js  (A PAGE THE USER DID NOT KEEP NEVER CROSSES)
 * ============================================================================
 * The export (core/export.js) copies each kept page with pdf-lib's copyPages,
 * and its object copier follows EVERY reference out of the page. To it a page
 * reference is just another reference: a TOC link's /Dest, an annotation's /P,
 * a form widget's /Parent -> field /Kids -> a sibling widget's /P. Each one
 * pulled its target page across as an orphan object, and save() writes every
 * object the document holds, reachable or not. Extracting 2 of 40 pages of a
 * skripsi with a linked TOC shipped all 40, and a page the user deleted for
 * privacy was still inside the file they sent (round-1 hunt, 2026-10-11).
 * The same copy left every link in a rebuilt file pointing at an orphan copy
 * instead of at the output page.
 *
 * WHY BEFORE THE COPY, on the export's private load of the source: once
 * copyPages has run the orphans are registered in the output and save() will
 * write them, so pruning afterwards cannot work. buildPdfBytes loads its own
 * copy of each source per export, so rewriting that copy touches nothing the
 * user or the screen holds.
 *
 * The fence: every reference to a page, a page-tree node or the catalog that
 * is reachable from a kept page is rewritten before the copier can follow it.
 * A reference to a KEPT page becomes a placeholder name, which landPageRefs
 * turns into that page's output ref once the output pages exist (a repeated
 * page lands on its first copy); a reference to anything else becomes null.
 * A link to a page that was not kept is removed, not left pointing at nothing;
 * a widget whose field also has widgets on pages that were not kept leaves the
 * field and carries the field's value itself, because the output never has an
 * /AcroForm (newDoc is created empty) so membership bought no fillability.
 *
 * Named destinations (a /Dest that is a name or string) reference no page, so
 * they cannot leak one; they already point nowhere in a rebuilt file because
 * the catalog's name tree is not copied. Not handled here.
 */

const INHERITED_FIELD_KEYS = ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen', 'Opt', 'TI', 'I'];

// The output name standing in for kept page `n` of the source fenced with
// `tag`. export.js keys its landing map with the same call, so the two sides
// cannot spell it differently.
export function pagePlaceholder(PDFLib, tag, n) {
  return PDFLib.PDFName.of(`${tag}${n}`);
}

// Walk everything reachable from `roots` (page dicts), dicts and arrays only,
// never stream bytes. `rewrite(value)` returns a replacement to write in place
// (and not descend), or undefined to descend. A root's own /Parent is skipped:
// copyPages drops it from the page it copies, so it is not a path the copier
// takes; any OTHER /Parent (a widget's field) is.
function rewriteReachable(context, PDFLib, roots, rewrite) {
  const { PDFDict, PDFArray, PDFStream, PDFRef, PDFName } = PDFLib;
  const PARENT = PDFName.of('Parent');
  const rootSet = new Set(roots);
  const seen = new Set();
  const seenRefs = new Set();
  const stack = [...roots];
  const push = (v) => {
    if (v instanceof PDFRef) {
      const key = v.toString();
      if (seenRefs.has(key)) return;
      seenRefs.add(key);
      const target = context.lookup(v);
      if (target) stack.push(target);
    } else if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) {
      stack.push(v);
    }
  };
  while (stack.length) {
    let obj = stack.pop();
    if (obj instanceof PDFStream) obj = obj.dict;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (key === PARENT && rootSet.has(obj)) continue;
        const next = rewrite(value);
        if (next !== undefined) obj.set(key, next);
        else push(value);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i += 1) {
        const value = obj.get(i);
        const next = rewrite(value);
        if (next !== undefined) obj.set(i, next);
        else push(value);
      }
    }
  }
}

function isSubtype(PDFLib, dict, name) {
  return dict instanceof PDFLib.PDFDict && dict.lookup(PDFLib.PDFName.of('Subtype')) === PDFLib.PDFName.of(name);
}

function linkDest(PDFLib, link) {
  const { PDFName, PDFDict } = PDFLib;
  const dest = link.lookup(PDFName.of('Dest'));
  if (dest) return dest;
  const action = link.lookup(PDFName.of('A'));
  if (action instanceof PDFDict && action.lookup(PDFName.of('S')) === PDFName.of('GoTo')) {
    return action.lookup(PDFName.of('D'));
  }
  return undefined;
}

// Every widget of the field family `widget` belongs to, as ref strings, plus
// whether some member could not be named by ref (a direct kid can never be in
// a page's /Annots, so it counts as escaping).
function fieldFamily(PDFLib, context, widget) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = PDFLib;
  const ancestors = [];
  let top = widget;
  for (let p = widget.lookup(PDFName.of('Parent')); p instanceof PDFDict && !ancestors.includes(p);
    p = p.lookup(PDFName.of('Parent'))) {
    ancestors.push(p);
    top = p;
  }
  const refs = new Set();
  let direct = false;
  const seen = new Set();
  const stack = [top];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    const kids = node.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) continue;
    for (const raw of kids.asArray()) {
      const kid = context.lookup(raw);
      if (!(kid instanceof PDFDict)) continue;
      if (isSubtype(PDFLib, kid, 'Widget')) {
        if (raw instanceof PDFRef) refs.add(raw.toString());
        else direct = true;
      } else {
        stack.push(kid);
      }
    }
  }
  return { ancestors, refs, direct };
}

// Rewrite `srcDoc` (the export's private load) so copying any page in
// `keptNums` can reach no page outside it. Returns true when a placeholder was
// written, i.e. when landPageRefs has work to do.
export function fenceUnkeptPages(srcDoc, keptNums, tag, PDFLib) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNull, PDFPageLeaf, PDFPageTree } = PDFLib;
  const context = srcDoc.context;
  const pages = srcDoc.getPages();
  // The index copyPages uses IS getPages() order, so that is the numbering here.
  const leafIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  // Walls: the catalog and every page-tree node, found by walking /Kids rather
  // than by type, so an untyped tree is fenced too.
  const walls = new Set();
  const rootRef = context.trailerInfo.Root;
  if (rootRef instanceof PDFRef) walls.add(rootRef.toString());
  const treeRef = srcDoc.catalog.get(PDFName.of('Pages'));
  const treeStack = treeRef instanceof PDFRef ? [treeRef] : [];
  while (treeStack.length) {
    const ref = treeStack.pop();
    const key = ref.toString();
    if (walls.has(key) || leafIndex.has(key)) continue;
    const node = context.lookup(ref);
    const kids = node instanceof PDFDict ? node.lookup(PDFName.of('Kids')) : null;
    if (!(kids instanceof PDFArray)) continue; // a leaf getPages did not list: caught by type below
    walls.add(key);
    for (const kid of kids.asArray()) if (kid instanceof PDFRef) treeStack.push(kid);
  }
  const unkept = (ref) => {
    if (!(ref instanceof PDFRef)) return false;
    const key = ref.toString();
    const i = leafIndex.get(key);
    if (i !== undefined) return !keptNums.has(i);
    if (walls.has(key)) return true;
    const target = context.lookup(ref);
    return target instanceof PDFPageLeaf || target instanceof PDFPageTree;
  };

  const kept = [...keptNums].filter((n) => pages[n]).map((n) => pages[n]);

  // 1. Links to a page that was not kept go, rather than shipping pointing
  //    at nothing.
  const keptAnnots = new Set();
  for (const page of kept) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const entries = annots.asArray();
    const survivors = entries.filter((raw) => {
      const a = context.lookup(raw);
      if (!isSubtype(PDFLib, a, 'Link')) return true;
      const dest = linkDest(PDFLib, a);
      return !(dest instanceof PDFArray && unkept(dest.get(0)));
    });
    if (survivors.length !== entries.length) page.node.set(PDFName.of('Annots'), context.obj(survivors));
    for (const raw of survivors) if (raw instanceof PDFRef) keptAnnots.add(raw.toString());
  }

  // 2. A widget whose field reaches a widget off the kept pages leaves the
  //    field, carrying the field's inheritable entries so it still shows (and
  //    a reader can still synthesise) the same value.
  for (const page of kept) {
    for (const raw of page.node.Annots()?.asArray() || []) {
      const widget = context.lookup(raw);
      if (!isSubtype(PDFLib, widget, 'Widget') || !widget.get(PDFName.of('Parent'))) continue;
      const { ancestors, refs, direct } = fieldFamily(PDFLib, context, widget);
      if (!direct && [...refs].every((r) => keptAnnots.has(r))) continue;
      for (const name of INHERITED_FIELD_KEYS) {
        const key = PDFName.of(name);
        if (widget.has(key)) continue;
        const from = ancestors.find((a) => a.has(key));
        if (from) widget.set(key, from.get(key));
      }
      widget.delete(PDFName.of('Parent'));
    }
  }

  // 3. Every remaining page reference reachable from a kept page: a kept page
  //    becomes its placeholder, anything else null. Inherited /Resources are
  //    walked too: copyPages copies them onto the page it writes.
  let placed = false;
  const roots = kept.map((p) => p.node);
  for (const page of kept) {
    const res = page.node.Resources();
    if (res instanceof PDFDict) roots.push(res);
  }
  rewriteReachable(context, PDFLib, roots, (value) => {
    if (!(value instanceof PDFRef)) return undefined;
    const i = leafIndex.get(value.toString());
    if (i !== undefined && keptNums.has(i)) {
      placed = true;
      return pagePlaceholder(PDFLib, tag, i);
    }
    return unkept(value) ? PDFNull : undefined;
  });
  return placed;
}

// Replace every placeholder reachable from the output `pdfPages` with the
// output page ref `landing` maps it to (keyed by the placeholder PDFName).
export function landPageRefs(newDoc, pdfPages, landing, PDFLib) {
  rewriteReachable(newDoc.context, PDFLib, pdfPages.map((p) => p.node),
    (value) => (value instanceof PDFLib.PDFName ? landing.get(value) : undefined));
}
