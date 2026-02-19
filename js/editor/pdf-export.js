/*
 * PDFLokal - editor/pdf-export.js (ES Module)
 * PDF building and download with annotation embedding and font support
 */

import { ueState } from '../lib/state.js';
import { showToast, downloadBlob, getDownloadFilename } from '../lib/utils.js';

// Build final PDF bytes with all annotations embedded
// Separated from ueDownload so applyEditorProtect can reuse it
export async function ueBuildFinalPDF() {
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const fontCache = {};

  // Self-hosted fonts for offline support and privacy
  const customFontUrls = {
    'Montserrat': 'fonts/montserrat-regular.woff2',
    'Montserrat-Bold': 'fonts/montserrat-bold.woff2',
    'Montserrat-Italic': 'fonts/montserrat-italic.woff2',
    'Montserrat-BoldItalic': 'fonts/montserrat-bolditalic.woff2',
    'Carlito': 'fonts/carlito-regular.woff2',
    'Carlito-Bold': 'fonts/carlito-bold.woff2',
    'Carlito-Italic': 'fonts/carlito-italic.woff2',
    'Carlito-BoldItalic': 'fonts/carlito-bolditalic.woff2'
  };

  async function getFont(fontFamily, bold, italic) {
    console.log('[PDF Export] getFont called:', { fontFamily, bold, italic });
    let fontName = fontFamily || 'Helvetica';
    let isCustomFont = false;

    if (fontFamily === 'Helvetica') {
      if (bold && italic) fontName = 'HelveticaBoldOblique';
      else if (bold) fontName = 'HelveticaBold';
      else if (italic) fontName = 'HelveticaOblique';
      else fontName = 'Helvetica';
    } else if (fontFamily === 'Times-Roman') {
      if (bold && italic) fontName = 'TimesRomanBoldItalic';
      else if (bold) fontName = 'TimesRomanBold';
      else if (italic) fontName = 'TimesRomanItalic';
      else fontName = 'TimesRoman';
    } else if (fontFamily === 'Courier') {
      if (bold && italic) fontName = 'CourierBoldOblique';
      else if (bold) fontName = 'CourierBold';
      else if (italic) fontName = 'CourierOblique';
      else fontName = 'Courier';
    } else if (fontFamily === 'Montserrat') {
      isCustomFont = true;
      if (bold && italic) fontName = 'Montserrat-BoldItalic';
      else if (bold) fontName = 'Montserrat-Bold';
      else if (italic) fontName = 'Montserrat-Italic';
      else fontName = 'Montserrat';
    } else if (fontFamily === 'Carlito') {
      isCustomFont = true;
      if (bold && italic) fontName = 'Carlito-BoldItalic';
      else if (bold) fontName = 'Carlito-Bold';
      else if (italic) fontName = 'Carlito-Italic';
      else fontName = 'Carlito';
    } else {
      console.warn('[PDF Export] Unknown font family:', fontFamily, '- falling back to Helvetica');
      if (bold && italic) fontName = 'HelveticaBoldOblique';
      else if (bold) fontName = 'HelveticaBold';
      else if (italic) fontName = 'HelveticaOblique';
      else fontName = 'Helvetica';
    }

    if (!fontCache[fontName]) {
      if (isCustomFont) {
        try {
          const fontUrl = customFontUrls[fontName];
          const fontResponse = await fetch(fontUrl);
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
          console.error('[PDF Export] Invalid standard font name:', fontName, '- available fonts:', Object.keys(PDFLib.StandardFonts));
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
    if (annotations.length > 0) {
      const page = newDoc.getPages()[i];
      const { width, height } = page.getSize();
      const scaleInfo = ueState.pageScales[i] || { canvasWidth: width, canvasHeight: height };
      const scaleX = width / scaleInfo.canvasWidth;
      const scaleY = height / scaleInfo.canvasHeight;

      for (const anno of annotations) {
        switch (anno.type) {
          case 'whiteout':
            page.drawRectangle({
              x: anno.x * scaleX,
              y: height - (anno.y + anno.height) * scaleY,
              width: anno.width * scaleX,
              height: anno.height * scaleY,
              color: PDFLib.rgb(1, 1, 1)
            });
            break;
          case 'text':
            const textFont = await getFont(anno.fontFamily, anno.bold, anno.italic);
            const lines = anno.text.split('\n');
            const hexColor = anno.color.replace('#', '');
            const r = parseInt(hexColor.substr(0, 2), 16) / 255;
            const g = parseInt(hexColor.substr(2, 2), 16) / 255;
            const b = parseInt(hexColor.substr(4, 2), 16) / 255;
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
              page.drawText(lines[lineIdx], {
                x: anno.x * scaleX,
                y: height - (anno.y + lineIdx * anno.fontSize * 1.2) * scaleY,
                size: anno.fontSize * scaleY,
                font: textFont,
                color: PDFLib.rgb(r, g, b)
              });
            }
            break;
          case 'signature':
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
            break;
          case 'watermark':
            const wmFont = await getFont('Helvetica', false, false);
            const wmHex = anno.color.replace('#', '');
            page.drawText(anno.text, {
              x: anno.x * scaleX,
              y: height - anno.y * scaleY,
              size: anno.fontSize * scaleY,
              font: wmFont,
              color: PDFLib.rgb(
                parseInt(wmHex.substr(0, 2), 16) / 255,
                parseInt(wmHex.substr(2, 2), 16) / 255,
                parseInt(wmHex.substr(4, 2), 16) / 255
              ),
              opacity: anno.opacity,
              rotate: PDFLib.degrees(anno.rotation)
            });
            break;
        }
      }
    }
  }

  return await newDoc.save({
    useObjectStreams: true,
    addDefaultPage: false
  });
}

// Download PDF
export async function ueDownload() {
  if (ueState.pages.length === 0) {
    showToast('Tidak ada halaman untuk diunduh', 'error');
    return;
  }

  const downloadBtn = document.getElementById('ue-download-btn');
  const originalText = downloadBtn.innerHTML;

  // Optimization: If PDF is unmodified, download original bytes
  if (ueState.sourceFiles.length === 1) {
    let isUnmodified = true;
    const sourceFile = ueState.sourceFiles[0];

    for (let i = 0; i < ueState.pages.length; i++) {
      const page = ueState.pages[i];
      if (page.sourceIndex !== 0 || page.pageNum !== i || page.rotation !== 0) {
        isUnmodified = false;
        break;
      }

      const annotations = ueState.annotations[i] || [];
      if (annotations.length > 0) {
        isUnmodified = false;
        break;
      }
    }

    if (isUnmodified) {
      console.log('[PDF Download] Unmodified PDF detected, downloading original bytes');
      downloadBlob(
        new Blob([sourceFile.bytes], { type: 'application/pdf' }),
        getDownloadFilename({ originalName: sourceFile.name, extension: 'pdf' })
      );
      showToast('PDF berhasil diunduh!', 'success');
      return;
    }
  }

  // Show loading state
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
    showToast('PDF berhasil diunduh!', 'success');

  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalText;
  }
}
