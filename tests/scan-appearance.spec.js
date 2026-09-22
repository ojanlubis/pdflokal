import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('shaded scan: paper and lettering match pixels; exported cover keeps its gradient', async ({ page }) => {
  // Opt-in sabotage proves the export assertion sees a missing patch, without
  // modifying the shared working tree underneath a browser run.
  if (process.env.SCAN_BROKEN_EXPORT) await page.route('**/js/core/export.js', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('if (anno.ocrBox && anno.paperImage)', 'if (false)');
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { scanAppearance } = await import('/js/v2/scan-appearance.js');
    const { ensurePdfLib, ensurePdfJs } = await import('/js/core/vendor.js');
    const { createDoc, createSource, createPage, createAnnotation } = await import('/js/core/model.js');
    const { buildPdfBytes } = await import('/js/core/export.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const pdfjs = await ensurePdfJs();
    const c = document.createElement('canvas'); c.width = 700; c.height = 180;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const image = ctx.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
      const p = (y * c.width + x) * 4; const v = 245 - x * 0.09 - y * 0.04;
      image.data.set([v, v - 5, v - 12, 255], p);
    }
    ctx.putImageData(image, 0, 0);
    const text = 'Surat keterangan pekerjaan';
    await document.fonts.load('bold 30px Tinos', text);
    ctx.font = 'bold 30px Tinos'; ctx.fillStyle = '#202020';
    const metric = ctx.measureText(text); ctx.fillText(text, 55, 85);
    const line = { str: text, x: 51, y: 85 - metric.actualBoundingBoxAscent - 3,
      w: metric.width + 8, h: metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent + 6 };
    const appearance = await scanAppearance({ cx: ctx, w: c.width, h: c.height, s: 1 }, line);
    if (!appearance.paperImage) throw new Error('known smooth paper was declined');
    const patch = new Image(); patch.src = appearance.paperImage; await patch.decode();
    // Comparison artifact uses the production patch and chosen lettering.
    const before = c.toDataURL();
    ctx.drawImage(patch, line.x, line.y, line.w, line.h);
    const a = appearance.lettering;
    if (a) {
      ctx.font = `${a.italic ? 'italic' : 'normal'} ${a.bold ? 700 : 400} ${a.fontSize}px "${a.fontFamily}"`;
      ctx.fillStyle = a.color; ctx.fillText('Surat keterangan bekerja', a.x, a.y + a.fontSize * 0.9);
    }
    const after = c.toDataURL();
    const sourcePdf = await PDFLib.PDFDocument.create();
    const sourcePage = sourcePdf.addPage([700, 180]);
    sourcePage.drawImage(await sourcePdf.embedPng(before), { x: 0, y: 0, width: 700, height: 180 });
    const bytes = await sourcePdf.save();
    const doc = createDoc(); const source = createSource({ bytes, numPages: 1, name: 'synthetic.pdf' }); doc.sources.push(source);
    const pg = createPage({ source, sourcePageNum: 0, width: 700, height: 180 }); doc.pages.push(pg);
    pg.annotations.push(createAnnotation('whiteout', { x: line.x, y: line.y, width: line.w, height: line.h,
      ocrBox: line, paperImage: appearance.paperImage }));
    if (a) pg.annotations.push(createAnnotation('text', { ...a, text: 'Surat keterangan bekerja' }));
    const output = await buildPdfBytes(doc, { PDFLib, fontkit });
    const rendered = await pdfjs.getDocument({ data: output }).promise;
    const first = await rendered.getPage(1); const vp = first.getViewport({ scale: 1 });
    const out = document.createElement('canvas'); out.width = vp.width; out.height = vp.height;
    const oc = out.getContext('2d'); await first.render({ canvasContext: oc, viewport: vp }).promise;
    const samples = [0.1, 0.9].map((t) => {
      const x = Math.round(line.x + line.w * t); const y = Math.round(line.y + 1);
      return { actual: Array.from(oc.getImageData(x, y, 1, 1).data).slice(0, 3), expected: [245 - x * 0.09 - y * 0.04, 240 - x * 0.09 - y * 0.04, 233 - x * 0.09 - y * 0.04] };
    });
    await rendered.destroy();
    return { lettering: a, samples, before, after, exported: out.toDataURL() };
  });
  expect(result.lettering?.fontFamily).toBe('Tinos');
  expect(result.lettering?.bold).toBe(true);
  expect(result.lettering?.fontSize).toBeGreaterThan(27);
  expect(result.lettering?.fontSize).toBeLessThan(33);
  for (const sample of result.samples) sample.actual.forEach((v, i) => expect(Math.abs(v - sample.expected[i])).toBeLessThan(3));
  await test.info().attach('before', { body: Buffer.from(result.before.split(',')[1], 'base64'), contentType: 'image/png' });
  await test.info().attach('after', { body: Buffer.from(result.after.split(',')[1], 'base64'), contentType: 'image/png' });
  fs.mkdirSync('review-shots', { recursive: true });
  for (const name of ['before', 'after', 'exported']) fs.writeFileSync(`review-shots/scan-appearance-${name}.png`, Buffer.from(result[name].split(',')[1], 'base64'));
});

test('real OCR edit preserves matched appearance through re-edit and undo/redo', async ({ page }) => {
  await page.goto('/');
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 400;
    const cx = c.getContext('2d');
    const g = cx.createLinearGradient(0, 0, 800, 300); g.addColorStop(0, '#fff8eb'); g.addColorStop(1, '#b5aea1');
    cx.fillStyle = g; cx.fillRect(0, 0, 800, 400);
    await document.fonts.load('bold 32px Tinos');
    cx.font = 'bold 32px Tinos'; cx.fillStyle = '#222'; cx.fillText('Surat keterangan pekerjaan', 65, 120);
    cx.fillText('Nama lengkap dan alamat', 65, 185);
    cx.fillText('Dokumen untuk keperluan administrasi', 65, 250);
    return c.toDataURL().split(',')[1];
  });
  await page.setInputFiles('#file-input', { name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => window.v2?.getDoc().pages[0]?.raster);
  const id = await page.evaluate(async () => {
    const id = window.v2.getDoc().pages[0].id; await window.v2.runOcrOnPage(id); return id;
  });
  const point = await page.evaluate((id) => {
    const line = window.v2.ocrIndex.getLines(id).find((l) => l.str.includes('keterangan'));
    if (!line) throw new Error('OCR did not recognise the known line');
    const view = document.querySelector('.pv-page'); const box = view.getBoundingClientRect();
    return { x: box.x + (line.x + line.w / 2) * box.width / view.offsetWidth,
      y: box.y + (line.y + line.h / 2) * box.height / view.offsetHeight };
  }, id);
  await page.mouse.click(point.x, point.y);
  const editor = page.locator('.v2-text-edit'); await expect(editor).toBeVisible();
  await expect(editor).toHaveCSS('font-family', /Tinos/);
  await expect(editor).toHaveCSS('font-weight', '700');
  await page.keyboard.type('Surat keterangan bekerja'); await page.keyboard.press('Enter');
  const read = () => page.evaluate(() => {
    const annotations = window.v2.getDoc().pages[0].annotations;
    const cover = annotations.find((a) => a.ocrBox); const text = annotations.find((a) => a.ocrCoverId);
    return { image: cover?.paperImage, style: text && { x: text.x, y: text.y, fontSize: text.fontSize, fontFamily: text.fontFamily, bold: text.bold }, text: text?.text };
  });
  const first = await read(); expect(first.image).toMatch(/^data:image\/png/);
  await page.click('[data-tool="ganti"]'); await page.mouse.click(point.x, point.y);
  await expect(editor).toBeVisible(); await page.keyboard.type('Surat keterangan baru'); await page.keyboard.press('Enter');
  const second = await read(); expect(second.image).toBe(first.image); expect(second.style).toEqual(first.style);
  await page.keyboard.press('ControlOrMeta+z'); expect((await read()).text).toBe(first.text);
  await page.keyboard.press('ControlOrMeta+Shift+z'); expect(await read()).toEqual(second);
  await page.screenshot({ path: 'review-shots/scan-appearance-editor.png' });
});

test('short or unrecognisable lettering is not assigned a confident font', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { scanAppearance } = await import('/js/v2/scan-appearance.js');
    const c = document.createElement('canvas'); c.width = 300; c.height = 100;
    const cx = c.getContext('2d'); cx.fillStyle = '#eee'; cx.fillRect(0, 0, 300, 100);
    cx.fillStyle = '#111'; cx.fillRect(30, 30, 180, 20);
    const r = { cx, w: 300, h: 100, s: 1 };
    return Promise.all(['123', 'OCR words do not match these pixels'].map((str) => scanAppearance(r, { x: 25, y: 25, w: 190, h: 30, str })));
  });
  expect(result.every((r) => r.paperImage && !r.lettering)).toBe(true);
});
