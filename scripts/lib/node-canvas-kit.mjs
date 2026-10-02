/*
 * A canvas kit for node (see js/docx/canvaskit.js), built on @napi-rs/canvas, for the gate and the lane tools.
 * It is a MEASURING tool: the shipped engine runs on the browser's own canvas and never imports this.
 * The module is found, in order: $DOCX_CANVAS (a path to the package), then the normal resolution.
 * Resolves to null when there is none, and the engine then runs its canvas-free path.
 */
import { createRequire } from 'node:module';
import { kitFromNodeCanvas } from '../../js/docx/canvaskit.js';

export async function nodeCanvasKit() {
  const require = createRequire(import.meta.url);
  const where = process.env.DOCX_CANVAS || '@napi-rs/canvas';
  try { return kitFromNodeCanvas(require(where)); } catch { return null; }
}

// Which canvas a run is measured with, for the gate's header: 'none' means the canvas-free engine path.
export async function canvasLabel() {
  if (process.env.DOCX_NO_CANVAS) return 'none (DOCX_NO_CANVAS)';
  return (await nodeCanvasKit()) ? `@napi-rs/canvas (${process.env.DOCX_CANVAS || 'resolved from node_modules'})` : 'none (@napi-rs/canvas not found; set DOCX_CANVAS)';
}
