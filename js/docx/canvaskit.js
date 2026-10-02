/*
 * PDFLokal — docx/canvaskit.js  (the one seam to a 2D canvas)
 * ============================================================================
 * images.js paints an image "as the page shows it" by rendering it through pdf.js
 * onto a canvas, then encodes the canvas. That needs a canvas, and the two places
 * this engine runs have different ones:
 *
 *   browser   OffscreenCanvas (or a detached <canvas> where OffscreenCanvas is missing)
 *   node      none built in. The GATE injects one built from @napi-rs/canvas
 *             (scripts/lib/node-canvas-kit.mjs). It is a dev tool for measuring, NOT a
 *             runtime dependency: the shipped engine never imports it.
 *
 * A KIT is the smallest surface images.js needs:
 *
 *   kit.create(w, h)            -> { canvas, context }     a transparent canvas + its 2D context
 *   kit.encode(canvas, 'jpeg'|'png', quality01) -> Promise<Uint8Array>
 *   kit.canvasFactory           (optional) a pdf.js canvas factory INSTANCE (create/reset/destroy). pdf.js
 *                               builds its own scratch canvases (soft masks, patterns, big images); in a
 *                               browser it finds document.createElement on its own, in node it must be told.
 *                               convert.js passes it to getDocument({ canvasFactory }) when present.
 *
 * Callers pass a kit as `options.canvasKit`; with none, defaultKit() picks the browser one, and in a
 * runtime with no canvas at all it is null, and images.js falls back to the raw-pixel path (no clip,
 * no soft mask: the old behaviour), which stays correct for plain opaque pictures.
 */

// A pdf.js canvas factory over any `create(w,h)` that returns { canvas, context }.
export function makePdfjsCanvasFactory(create) {
  return new (class KitCanvasFactory {
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      return create(Math.ceil(width), Math.ceil(height));
    }

    reset(cc, width, height) {
      if (!cc.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      cc.canvas.width = Math.ceil(width);
      cc.canvas.height = Math.ceil(height);
    }

    destroy(cc) {
      if (!cc.canvas) throw new Error('Canvas is not specified');
      cc.canvas.width = 0;
      cc.canvas.height = 0;
      cc.canvas = null;
      cc.context = null;
    }
  })();
}

export function browserKit() {
  const g = globalThis;
  if (typeof g.OffscreenCanvas !== 'undefined') {
    const create = (w, h) => {
      const canvas = new g.OffscreenCanvas(w, h);
      return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
    };
    return {
      create,
      async encode(canvas, type, quality) {
        const blob = await canvas.convertToBlob({ type: `image/${type}`, quality });
        return new Uint8Array(await blob.arrayBuffer());
      },
      // In a Web Worker there is no document: pdf.js's own canvas factory reaches for document.createElement the first
      // time a render needs a scratch canvas (a soft mask, a pattern, a big image) and the render fails. Hand it ours.
      // (A page with a document keeps pdf.js's own: it is the path every other tool in the product takes.)
      ...(typeof g.document === 'undefined' ? { canvasFactory: makePdfjsCanvasFactory(create) } : {}),
    };
  }
  if (typeof g.document !== 'undefined' && g.document.createElement) {
    return {
      create(w, h) {
        const canvas = g.document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
      },
      encode(canvas, type, quality) {
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('toBlob failed'))), `image/${type}`, quality);
        });
      },
    };
  }
  return null;
}

// A kit over an @napi-rs/canvas / node-canvas style module ({ createCanvas }).
export function kitFromNodeCanvas(mod) {
  const create = (w, h) => {
    const canvas = mod.createCanvas(w, h);
    return { canvas, context: canvas.getContext('2d') };
  };
  return {
    create,
    async encode(canvas, type, quality) {
      const buf = canvas.toBuffer(`image/${type}`, type === 'jpeg' ? Math.round(quality * 100) : undefined);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
    },
    canvasFactory: makePdfjsCanvasFactory(create),
  };
}

export function defaultKit(options) {
  return (options && options.canvasKit) || browserKit();
}
