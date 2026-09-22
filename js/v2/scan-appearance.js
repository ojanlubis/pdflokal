import { estimatePaper, paperAt } from '../core/scan-paper.js';

const FAMILIES = ['Arimo', 'Tinos', 'Carlito', 'Cousine'];
const STYLES = [{ bold: false, italic: false }, { bold: true, italic: false },
  { bold: false, italic: true }, { bold: true, italic: true }];
const fontCss = (f, s, size) => `${s.italic ? 'italic' : 'normal'} ${s.bold ? 700 : 400} ${size}px "${f}"`;
const canvas = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

function paperModel(r, line) {
  const { x, y, w, h } = line;
  const samples = [];
  const gap = Math.max(2, h * 0.12);
  const take = (px, py) => {
    const ix = Math.floor(px * r.s); const iy = Math.floor(py * r.s);
    if (ix < 0 || iy < 0 || ix >= r.w || iy >= r.h) return;
    const rgb = Array.from(r.cx.getImageData(ix, iy, 1, 1).data).slice(0, 3);
    samples.push({ x: (px - x) / w, y: (py - y) / h, rgb });
  };
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    take(x + w * t, y - gap); take(x + w * t, y + h + gap);
    take(x - gap, y + h * t); take(x + w + gap, y + h * t);
  }
  return estimatePaper(samples);
}

function paperImage(plane) {
  // A smooth plane needs only a small lossless tile. The exact same PNG is
  // used by the editor and PDF writer; no CSS-vs-PDF gradient approximation.
  const c = canvas(64, 32); const ctx = c.getContext('2d');
  const pixels = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
    const i = (y * c.width + x) * 4;
    pixels.data.set([...paperAt(plane, x / (c.width - 1), y / (c.height - 1)), 255], i);
  }
  ctx.putImageData(pixels, 0, 0);
  return c.toDataURL('image/png');
}

// Trim a monochrome ink mask before comparing letter shapes. Normalisation
// removes the scan's size, but the aspect ratio is scored separately so a
// narrow font stretched wide cannot win merely by filling the same box.
function maskShape(c) {
  const ctx = c.getContext('2d');
  const p = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1; let count = 0;
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
    if (p[(y * c.width + x) * 4] > 100) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); count += 1;
  }
  if (count < 20 || x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const normal = canvas(192, 32); const nc = normal.getContext('2d');
  nc.drawImage(c, x0, y0, w, h, 0, 0, normal.width, normal.height);
  const data = nc.getImageData(0, 0, normal.width, normal.height).data;
  return { data, ratio: w / h, height: h, top: y0, left: x0 };
}

async function matchLettering(r, line, plane) {
  if (line.str.length < 5 || line.str.length > 100 || !/^[\x20-\x7e]+$/.test(line.str)) return null;
  const scale = Math.min(r.s, 1200 / line.w, 100 / line.h);
  const c = canvas(Math.max(1, Math.ceil(line.w * scale)), Math.max(1, Math.ceil(line.h * scale)));
  const ctx = c.getContext('2d');
  ctx.drawImage(r.cx.canvas, line.x * r.s, line.y * r.s, line.w * r.s, line.h * r.s, 0, 0, c.width, c.height);
  const pixels = ctx.getImageData(0, 0, c.width, c.height);
  const ink = [];
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
    const i = (y * c.width + x) * 4;
    const paper = paperAt(plane, x / c.width, y / c.height);
    const delta = paper.reduce((sum, v, ch) => sum + v - pixels.data[i + ch], 0) / 3;
    const dark = delta > 45;
    if (delta > 90) ink.push(Array.from(pixels.data.slice(i, i + 3)));
    pixels.data[i] = dark ? 0 : 255; pixels.data[i + 1] = pixels.data[i]; pixels.data[i + 2] = pixels.data[i]; pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const source = maskShape(c);
  if (!source || source.height < 8) return null;
  const candidates = (await Promise.all(FAMILIES.flatMap((family) => STYLES.map(async (style) => {
    const css = fontCss(family, style, 40);
    try {
      const loaded = await document.fonts.load(css, line.str);
      if (!loaded.length) return null;
    } catch { return null; }
    const measure = canvas(1, 1).getContext('2d'); measure.font = css;
    const metrics = measure.measureText(line.str);
    const candidate = canvas(Math.ceil(metrics.width + 80), 100);
    const cc = candidate.getContext('2d'); cc.fillStyle = '#fff'; cc.fillRect(0, 0, candidate.width, candidate.height);
    cc.font = css; cc.fillStyle = '#000'; cc.fillText(line.str, 40, 60);
    const shape = maskShape(candidate);
    if (!shape) return null;
    let diff = 0;
    for (let i = 0; i < shape.data.length; i += 4) diff += Math.abs(shape.data[i] - source.data[i]) / 255;
    const score = diff / (shape.data.length / 4) + Math.abs(Math.log(shape.ratio / source.ratio)) * 0.4;
    const fontSize = 40 * (source.height / scale) / shape.height;
    // Both the overlay and PDF drawer use baseline = top + 0.9em.
    const ascent = metrics.actualBoundingBoxAscent * fontSize / 40;
    return { score, fontFamily: family, ...style, fontSize,
      x: line.x + source.left / scale + metrics.actualBoundingBoxLeft * fontSize / 40,
      y: line.y + source.top / scale + ascent - fontSize * 0.9 };
  })))).filter(Boolean).sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || best.score > 0.22 || (candidates[1] && candidates[1].score - best.score < 0.015)
    || best.fontSize < 6 || best.fontSize > 120) return null;
  if (ink.length) {
    const med = (ch) => ink.map((p) => p[ch]).sort((a, b) => a - b)[Math.floor(ink.length / 2)];
    best.color = `#${[0, 1, 2].map((ch) => med(ch).toString(16).padStart(2, '0')).join('')}`;
  }
  return best;
}

export async function scanAppearance(r, line) {
  if (!r || ![line.x, line.y, line.w, line.h].every(Number.isFinite) || line.w <= 0 || line.h <= 0) return {};
  const plane = paperModel(r, line);
  if (!plane) return {};
  const image = paperImage(plane);
  // A blocked font request must not trap the tap-to-edit flow. Late font
  // loads may populate the browser cache, but never mutate an open draft.
  let timer;
  try {
    const lettering = await Promise.race([matchLettering(r, line, plane),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1200); })]);
    return { paperImage: image, lettering };
  } finally { clearTimeout(timer); }
}
