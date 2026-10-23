/*
 * PDFLokal — core/sig-bar.js
 * What the strip above the page shows. Pure: no DOM, no i18n (the caller maps
 * `label` to a literal tr() key so the i18n scan can see each one).
 *
 * Three moments: a SELECTED signature, a SELECTED picture (Gambar), or an armed
 * tool waiting for a tap. A picture is the signature object with kind:'picture',
 * so it must not present as a signature: its own label, and no "Gambar Ulang"
 * (that reopens the signature drawing sheet, which has nothing to do with it).
 */
import { isPicture } from './operations.js';

// selected: the selected signature-type annotation or null.
export function sigBarState({ selected, armedSig, armedGambar, pageCount }) {
  const found = !!selected;
  const picture = found && isPicture(selected);
  const armed = !!armedSig || !!armedGambar;
  return {
    show: found || armed,
    showAllPages: found && pageCount > 1,
    showRedraw: !!armedSig || (found && !picture), // never on a picture: it is not a signature
    label: picture ? 'picture' : found ? 'signature' : armed ? 'armed' : '',
  };
}
