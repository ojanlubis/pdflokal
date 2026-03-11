/*
 * PDFLokal - editor/pdf-export.js (ES Module)
 * PDF building and download with annotation embedding and font support
 */

import { ueState } from '../lib/state.js';
import { showToast, downloadBlob, getDownloadFilename } from '../lib/utils.js';
import { track } from '../lib/analytics.js';

// WHY: Lookup table replaces giant if/else chain in getFont to reduce complexity (S3776).
// Key format: [family]-[bold]-[italic] → pdf-lib font name.
const FONT_NAME_MAP = {
  'Helvetica':      { '00': 'Helvetica', '10': 'HelveticaBold', '01': 'HelveticaOblique', '11': 'HelveticaBoldOblique' },
  'Times-Roman':    { '00': 'TimesRoman', '10': 'TimesRomanBold', '01': 'TimesRomanItalic', '11': 'TimesRomanBoldItalic' },
  'Courier':        { '00': 'Courier', '10': 'CourierBold', '01': 'CourierOblique', '11': 'CourierBoldOblique' },
  'Montserrat':     { '00': 'Montserrat', '10': 'Montserrat-Bold', '01': 'Montserrat-Italic', '11': 'Montserrat-BoldItalic' },
  'Carlito':        { '00': 'Carlito', '10': 'Carlito-Bold', '01': 'Carlito-Italic', '11': 'Carlito-BoldItalic' },
};

const CUSTOM_FONT_URLS = {
  'Montserrat': 'fonts/montserrat-regular.woff2',
  'Montserrat-Bold': 'fonts/montserrat-bold.woff2',
  'Montserrat-Italic': 'fonts/montserrat-italic.woff2',
  'Montserrat-BoldItalic': 'fonts/montserrat-bolditalic.woff2',
  'Carlito': 'fonts/carlito-regular.woff2',
  'Carlito-Bold': 'fonts/carlito-bold.woff2',
  'Carlito-Italic': 'fonts/carlito-italic.woff2',
  'Carlito-BoldItalic': 'fonts/carlito-bolditalic.woff2'
};

const CUSTOM_FONT_FAMILIES = new Set(['Montserrat', 'Carlito']);

function resolveFontName(fontFamily, bold, italic) {
  const variant = `${bold ? '1' : '0'}${italic ? '1' : '0'}`;
  const family = FONT_NAME_MAP[fontFamily];
  if (family) return { name: family[variant], isCustom: CUSTOM_FONT_FAMILIES.has(fontFamily) };
  console.warn('[PDF Export] Unknown font family:', fontFamily, '- falling back to Helvetica');
  return { name: FONT_NAME_MAP['Helvetica'][variant], isCustom: false };
}

// WHY: Extracted per-annotation-type embedding to reduce ueBuildFinalPDF complexity (S3776).
function parseHexColor(hex) {
  const h = hex.replace('#', '');
  return PDFLib.rgb(
    Number.parseInt(h.substr(0, 2), 16) / 255,
    Number.parseInt(h.substr(2, 2), 16) / 255,
    Number.parseInt(h.substr(4, 2), 16) / 255
  );
}

async function embedTextAnnotation(page, anno, scaleX, scaleY, height, getFont) {
  const textFont = await getFont(anno.fontFamily, anno.bold, anno.italic);
  const lines = anno.text.split('\n');
  const color = parseHexColor(anno.color);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    page.drawText(lines[lineIdx], {
      x: anno.x * scaleX,
      y: height - (anno.y + lineIdx * anno.fontSize * 1.2) * scaleY,
      size: anno.fontSize * scaleY,
      font: textFont,
      color
    });
  }
}

async function embedSignatureAnnotation(page, anno, scaleX, scaleY, height, newDoc) {
  const isJpeg = anno.image.startsWith('data:image/jpeg');
  const signatureImage = isJpeg
    ? await newDoc.embedJpg(anno.image)
    : await newDoc.embedPng(anno.image);
  page.drawImage(signatureImage, {
    x: anno.x * scaleX,
    y: height - (anno.y + anno.height) * scaleY,
    width: anno.width * scaleX,
    height: anno.height * scaleY
  });
}

async function embedWatermarkAnnotation(page, anno, scaleX, scaleY, height, getFont) {
  const wmFont = await getFont('Helvetica', false, false);
  page.drawText(anno.text, {
    x: anno.x * scaleX,
    y: height - anno.y * scaleY,
    size: anno.fontSize * scaleY,
    font: wmFont,
    color: parseHexColor(anno.color),
    opacity: anno.opacity,
    rotate: PDFLib.degrees(anno.rotation)
  });
}

// Build final PDF bytes with all annotations embedded
// Separated from ueDownload so applyEditorProtect can reuse it
export async function ueBuildFinalPDF() {
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const fontCache = {};

  async function getFont(fontFamily, bold, italic) {
    console.log('[PDF Export] getFont called:', { fontFamily, bold, italic });
    const { name: fontName, isCustom } = resolveFontName(fontFamily || 'Helvetica', bold, italic);

    if (!fontCache[fontName]) {
      if (isCustom) {
        try {
          const fontResponse = await fetch(CUSTOM_FONT_URLS[fontName]);
          const fontBytes = await fontResponse.arrayBuffer();
          fontCache[fontName] = await newDoc.embedFont(fontBytes);
          console.log('[PDF Export] ✓ Embedded font:', fontName, `(${(fontBytes.byteLength / 1024).toFixed(1)}KB)`);
        } catch (err) {
          console.error('[PDF Export] ✗ Failed to load font:', fontName, err);
          const fallbackName = bold ? 'Helvetica-Bold' : 'Helvetica';
          if (!fontCache[fallbackName]) {
            fontCache[fallbackName] = await newDoc.embedFont(PDFLib.StandardFonts[fallbackName]);
          }
          return fontCache[fallbackName];
        }
      } else {
        const standardFont = PDFLib.StandardFonts[fontName];
        if (!standardFont) {
          console.error('[PDF Export] Invalid standard font name:', fontName);
          const fallback = bold ? PDFLib.StandardFonts.HelveticaBold : PDFLib.StandardFonts.Helvetica;
          fontCache[fontName] = await newDoc.embedFont(fallback);
        } else {
          fontCache[fontName] = await newDoc.embedFont(standardFont);
        }
      }
    }
    return fontCache[fontName];
  }

  for (let i = 0; i < ueState.pages.length; i++) {
    const pageInfo = ueState.pages[i];
    const source = ueState.sourceFiles[pageInfo.sourceIndex];
    const srcDoc = await PDFLib.PDFDocument.load(source.bytes);

    const [copiedPage] = await newDoc.copyPages(srcDoc, [pageInfo.pageNum]);

    if (pageInfo.rotation !== 0) {
      copiedPage.setRotation(PDFLib.degrees(pageInfo.rotation));
    }

    newDoc.addPage(copiedPage);

    const annotations = ueState.annotations[i] || [];
    if (annotations.length === 0) continue;

    const page = newDoc.getPages()[i];
    const pageSize = page.getSize();
    // Use pageScales from PDF.js rendering for consistent coordinate mapping.
    // page.getSize() (pdf-lib MediaBox) can differ from PDF.js viewport dimensions
    // when PDFs have CropBox or non-standard page definitions.
    const scaleInfo = ueState.pageScales[i];
    const pdfW = scaleInfo ? scaleInfo.pdfWidth : pageSize.width;
    const pdfH = scaleInfo ? scaleInfo.pdfHeight : pageSize.height;
    const canvasW = scaleInfo ? scaleInfo.canvasWidth : pageSize.width;
    const canvasH = scaleInfo ? scaleInfo.canvasHeight : pageSize.height;
    const scaleX = pdfW / canvasW;
    const scaleY = pdfH / canvasH;

    for (const anno of annotations) {
      if (anno.type === 'whiteout') {
        page.drawRectangle({
          x: anno.x * scaleX,
          y: pdfH - (anno.y + anno.height) * scaleY,
          width: anno.width * scaleX,
          height: anno.height * scaleY,
          color: PDFLib.rgb(1, 1, 1)
        });
      } else if (anno.type === 'text') {
        await embedTextAnnotation(page, anno, scaleX, scaleY, pdfH, getFont);
      } else if (anno.type === 'signature') {
        await embedSignatureAnnotation(page, anno, scaleX, scaleY, pdfH, newDoc);
      } else if (anno.type === 'watermark') {
        await embedWatermarkAnnotation(page, anno, scaleX, scaleY, pdfH, getFont);
      }
    }
  }

  return await newDoc.save({
    useObjectStreams: true,
    addDefaultPage: false
  });
}

// WHY: Prevents double-click triggering two concurrent PDF builds.
// PDF generation is async and modifies shared pdf-lib document.
let isDownloading = false;

// WHY: Extracted from ueDownload to reduce cognitive complexity (S3776).
// Returns the source file if PDF is completely unmodified, or null if edits were made.
function getUnmodifiedSource() {
  if (ueState.sourceFiles.length !== 1) return null;
  const sourceFile = ueState.sourceFiles[0];

  if (sourceFile.numPages && ueState.pages.length !== sourceFile.numPages) return null;

  for (let i = 0; i < ueState.pages.length; i++) {
    const page = ueState.pages[i];
    if (page.sourceIndex !== 0 || page.pageNum !== i || page.rotation !== 0) return null;
    if ((ueState.annotations[i] || []).length > 0) return null;
  }
  return sourceFile;
}

// Download PDF
export async function ueDownload() {
  if (isDownloading) return;
  if (ueState.pages.length === 0) {
    showToast('Tidak ada halaman untuk diunduh', 'error');
    return;
  }

  const downloadBtn = document.getElementById('ue-download-btn');
  const originalText = downloadBtn.innerHTML;

  // Optimization: If PDF is unmodified, download original bytes
  const unmodified = getUnmodifiedSource();
  if (unmodified) {
    console.log('[PDF Download] Unmodified PDF detected, downloading original bytes');
    downloadBlob(
      new Blob([unmodified.bytes], { type: 'application/pdf' }),
      getDownloadFilename({ originalName: unmodified.name, extension: 'pdf' })
    );
    track('download', { tool: 'unified-editor' });
    showToast('PDF berhasil diunduh!', 'success');
    return;
  }

  // Show loading state
  isDownloading = true;
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `
    <svg class="btn-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
    </svg>
    Memproses...
  `;

  try {
    const pdfBytes = await ueBuildFinalPDF();
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));
    track('download', { tool: 'unified-editor' });
    showToast('PDF berhasil diunduh!', 'success');

  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
  } finally {
    isDownloading = false;
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalText;
  }
}
