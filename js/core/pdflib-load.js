/*
 * PDFLokal — core/pdflib-load.js  (THE LOAD EVERY REBUILD STARTS FROM)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for "parse a source PDF with pdf-lib so we can copy
 * its pages into a new file". Used by the exporter (core/export.js), the
 * edit preview bake (v2/edit-bake.js), the merge guard (core/import.js
 * pdfLibLoadError) and the OCR text layer (core/ocr-layer.js), so the guard
 * that says "this file can be rebuilt" runs the very load the rebuild runs.
 *
 * WHY NOT JUST `PDFDocument.load`: pdf-lib decides what a page-tree node IS
 * from its /Type at parse time (/Pages → PDFPageTree, /Page → PDFPageLeaf,
 * anything else → a plain dict). PDF.js walks the tree by /Kids and never
 * asks. So a file whose producer left /Type off its page-tree nodes opens,
 * renders and edits normally here, while pdf-lib sees zero pages or cannot
 * walk the tree at all, and every rebuild dies in copyPages. The user finds
 * out at Unduh, after the work is done, and no retry can succeed
 * (tests/core/export-untyped-page-tree.test.mjs).
 *
 * The same split shows on a /Kids entry that is the page dict itself instead
 * of a reference to it (the spec says indirect; some producers inline one).
 * PDF.js walks it; pdf-lib's page list skips it when untyped, so every later
 * page shifts down one and the download silently carries the wrong page, or
 * throws when typed, because a PDFPage needs a ref.
 *
 * The repair retypes those nodes, and registers inlined kids as objects of
 * their own, in the in-memory pdf-lib copy only. The user's own bytes are
 * never touched; a sound tree (typed, indirect) is left exactly as parsed.
 */

// Load `bytes` for a rebuild. `options` pass straight to PDFDocument.load.
export async function loadForRebuild(PDFLib, bytes, options) {
  const doc = await PDFLib.PDFDocument.load(bytes, options);
  retypePageTree(PDFLib, doc);
  return doc;
}

// Give every untyped node of `doc`'s page tree the class pdf-lib would have
// parsed it as had /Type been there, and write the /Type back so the rebuilt
// file says it too. Returns how many nodes it retyped (0 for a sound file).
//
// A node is a TREE node when it has /Kids, otherwise a LEAF; that is the same
// test PDF.js uses, which is why the file looked fine on screen. Walked from
// the catalog's /Pages down, a visited set guarding against a cyclic /Kids.
// A node is retyped behind its ref (context.assign swaps the object, so every
// /Kids and /Parent pointing at it sees the new class). A kid inlined as a
// direct dict has no ref, so it is registered first and its /Kids slot is
// pointed at the new ref; that counts toward the return value too.
export function retypePageTree(PDFLib, doc) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFPageTree, PDFPageLeaf } = PDFLib;
  const { context } = doc;
  const KIDS = PDFName.of('Kids');
  const TYPE = PDFName.of('Type');
  const visited = new Set();
  const stack = [doc.catalog.get(PDFName.of('Pages'))];
  let retyped = 0;

  while (stack.length) {
    let ref = stack.pop();
    if (ref instanceof Inlined) {
      ref.kids.set(ref.index, context.register(ref.dict));
      ref = ref.kids.get(ref.index);
      retyped += 1;
    }
    if (!(ref instanceof PDFRef) || visited.has(ref.toString())) continue;
    visited.add(ref.toString());
    let node = context.lookup(ref);
    if (!(node instanceof PDFDict)) continue;

    if (!(node instanceof PDFPageTree) && !(node instanceof PDFPageLeaf)) {
      const isTree = context.lookup(node.get(KIDS)) instanceof PDFArray;
      const map = new Map(node.entries());
      node = isTree
        ? PDFPageTree.fromMapWithContext(map, context)
        : PDFPageLeaf.fromMapWithContext(map, context);
      node.set(TYPE, PDFName.of(isTree ? 'Pages' : 'Page'));
      context.assign(ref, node);
      retyped += 1;
    }

    if (node instanceof PDFPageTree) {
      const kids = context.lookup(node.get(KIDS));
      if (kids instanceof PDFArray) {
        const entries = kids.asArray().map((kid, index) =>
          (kid instanceof PDFDict ? new Inlined(kids, index, kid) : kid));
        stack.push(...entries.reverse());
      }
    }
  }

  // pdf-lib caches the page list on first access. loadForRebuild repairs
  // before anyone has asked, but a caller that already did would otherwise
  // keep reading the empty list it cached from the broken tree.
  if (retyped > 0) {
    doc.pageCache.invalidate();
    doc.pageCount = undefined;
  }
  return retyped;
}

// A direct-dict kid waiting on the stack, with the /Kids slot it sits in.
class Inlined {
  constructor(kids, index, dict) { this.kids = kids; this.index = index; this.dict = dict; }
}
