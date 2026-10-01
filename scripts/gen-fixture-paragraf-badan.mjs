/*
 * Generate tests/fixtures/nasty/paragraf-badan.pdf — the BODY-PARAGRAPH fixture
 * for Rung D (whole-paragraph edit, core/block-edit.js + js/v2/block-editor.js).
 * Run: `node scripts/gen-fixture-paragraf-badan.mjs`.
 *
 * WHY a new fixture and not surat-paragraf.pdf: that one draws its justified
 * paragraph word by word, and two of its lines' first word gaps happen to end
 * within 0.2em of each other — paragraph-detect.js's aligned-gutter test reads
 * that as a table column, correctly by its own rule, so the paragraph is not a
 * block there (measured 2026-10-01). A real word processor writes a justified
 * line as ONE text object; this fixture does too.
 *
 * Contents (A4, Montserrat embedded WHOLE — subset:false — so the document's
 * own program is a provable native font for the edit):
 *   - a 16pt heading;
 *   - a JUSTIFIED body paragraph: 4 lines, 11pt, 15pt leading, the first three
 *     stretched to one width by character spacing (Tc: it applies to two-byte
 *     fonts, word spacing does not), the last line short and unstretched;
 *   - one blank line, then a LEFT-aligned (ragged) paragraph of 3 lines;
 *   - a closing line further down.
 * Each line is ONE drawText, so pdf.js reports one run per line.
 *
 * Same current-realm UMD loader as gen-fixture-paragraf.mjs (a vm sandbox
 * gives pdf-lib a different Uint8Array class).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

const doc = await PDFLib.PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/ttf/montserrat-regular.ttf'))),
  { subset: false },
);
const page = doc.addPage([595, 842]);
const ink = PDFLib.rgb(0.1, 0.1, 0.12);
const X = 72;

function draw(text, y, size, charSpacing = 0) {
  if (charSpacing) page.pushOperators(PDFLib.setCharacterSpacing(charSpacing));
  page.drawText(text, { x: X, y, size, font, color: ink });
  if (charSpacing) page.pushOperators(PDFLib.setCharacterSpacing(0));
}

draw('Pemberitahuan Kegiatan', 780, 16);

const SIZE = 11;
const LEAD = 15;
const justified = [
  'Sehubungan dengan pelaksanaan kegiatan kerja bakti di',
  'lingkungan kantor, seluruh pegawai diminta hadir pada hari',
  'Sabtu pagi dengan membawa peralatan kebersihan masing',
  'masing sesuai pembagian tugas.',
];
const natural = justified.map((t) => font.widthOfTextAtSize(t, SIZE));
const WIDTH = Math.max(...natural.slice(0, 3)) + 4;
justified.forEach((t, i) => {
  const last = i === justified.length - 1;
  const glyphs = [...t].length;
  const tc = last ? 0 : (WIDTH - natural[i]) / (glyphs - 1);
  draw(t, 740 - i * LEAD, SIZE, tc);
});

const ragged = [
  'Kegiatan dimulai pukul tujuh dan selesai sebelum',
  'pukul sepuluh. Konsumsi disediakan oleh panitia.',
  'Terima kasih atas perhatiannya.',
];
ragged.forEach((t, i) => draw(t, 740 - 5 * LEAD - i * LEAD, SIZE));

draw('Panitia Kerja Bakti', 520, SIZE);

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/paragraf-badan.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes), justified width ${WIDTH.toFixed(2)}pt`);
const reloaded = await PDFLib.PDFDocument.load(out);
if (reloaded.getPageCount() !== 1) throw new Error('fixture sanity check failed');
