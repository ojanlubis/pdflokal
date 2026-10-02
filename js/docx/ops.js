/*
 * PDFLokal — docx/ops.js  (the operator list, with the CTM tracked)
 * ============================================================================
 * The ONE place that walks a pdf.js operator list and keeps the current
 * transformation matrix. images.js uses it today; the colour lane (fills, vector
 * shapes) and anything else that needs "where on the page was this painted" must
 * use it instead of re-deriving save/restore/transform/form-XObject handling.
 *
 *   for (const ev of walkOps(pdfjs, ctx.ops)) {
 *     // ev = { i, fn, args, ctm }
 *     //   i    index into ops.fnArray / ops.argsArray (a stable z-order key)
 *     //   fn   pdfjs.OPS.* code     args  that op's arguments
 *     //   ctm  [a,b,c,d,e,f] in effect WHEN THE OP RUNS (before the op's own effect),
 *     //        user space -> default user space; multiply by vp.transform for page px.
 *   }
 *
 * It is a generator so the loop body can `await` (image decode does). The yielded
 * object is REUSED between iterations: copy what you keep. Tracks q/Q, cm, and form
 * XObjects (their matrix); it does NOT track colour or text state: that is the
 * caller's graphics-state work.
 */

export function* walkOps(pdfjs, ops) {
  const { OPS } = pdfjs;
  const mul = (m, n) => pdfjs.Util.transform(m, n);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const ev = { i: 0, fn: 0, args: null, ctm };
  const n = ops.fnArray.length;
  for (let i = 0; i < n; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    ev.i = i;
    ev.fn = fn;
    ev.args = args;
    ev.ctm = ctm;
    yield ev;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
  }
}
