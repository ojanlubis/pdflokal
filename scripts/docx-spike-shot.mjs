#!/usr/bin/env node
/*
 * Side-by-side page PNG: original page N | the .docx as LibreOffice renders it.
 *   node scripts/docx-spike-shot.mjs --out DIR --id n001 [--page 1] [--dpi 80]
 * Needs DIR/docx/ID.docx (from docx-spike.mjs), soffice and poppler. Writes DIR/shots/ID-pN.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const OUT = arg('out');
const ID = arg('id');
const PAGE = arg('page', '1');
const DPI = arg('dpi', '80');
const CORPUS = process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web';
const SOFFICE = process.env.SOFFICE || '/opt/homebrew/bin/soffice';

// --pdf / --docx override the source pair (used for OCR'd synthetic scans)
const SRC_PDF = arg('pdf', path.join(CORPUS, `${ID}.pdf`));
const SRC_DOCX = arg('docx', path.join(OUT, 'docx', `${ID}.docx`));
const rpdf = path.join(OUT, 'render', `${ID}.pdf`);
if (!fs.existsSync(rpdf)) {
  fs.mkdirSync(path.join(OUT, 'render'), { recursive: true });
  const r = spawnSync(SOFFICE, [`-env:UserInstallation=file://${path.join(os.tmpdir(), 'lo-shot')}`, '--headless', '--convert-to', 'pdf', '--outdir', path.join(OUT, 'render'), SRC_DOCX], { timeout: 300000 });
  const made = path.join(OUT, 'render', `${path.basename(SRC_DOCX, '.docx')}.pdf`);
  if (made !== rpdf && fs.existsSync(made)) fs.renameSync(made, rpdf);
  void r;
}
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const a = path.join(tmp, 'a');
const b = path.join(tmp, 'b');
spawnSync('pdftoppm', ['-r', DPI, '-png', '-f', PAGE, '-l', PAGE, '-singlefile', SRC_PDF, a]);
spawnSync('pdftoppm', ['-r', DPI, '-png', '-f', PAGE, '-l', PAGE, '-singlefile', rpdf, b]);
const A = PNG.sync.read(fs.readFileSync(`${a}.png`));
const B = PNG.sync.read(fs.readFileSync(`${b}.png`));
const gap = 16;
const H = Math.max(A.height, B.height);
const out = new PNG({ width: A.width + B.width + gap, height: H });
out.data.fill(200);
PNG.bitblt(A, out, 0, 0, A.width, A.height, 0, 0);
PNG.bitblt(B, out, 0, 0, B.width, B.height, A.width + gap, 0);
const dest = path.join(OUT, 'shots', `${ID}-p${PAGE}.png`);
fs.writeFileSync(dest, PNG.sync.write(out));
console.log(dest);
