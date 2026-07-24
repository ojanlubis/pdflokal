/*
 * PDFLokal — locales/id.js  (Bahasa Indonesia — the SOURCE language)
 * ============================================================================
 * The master dictionary. `id` is both what the app is written in AND the fallback
 * every other locale resolves through (see js/lib/i18n.js). So this file is the
 * canonical wording: when copy changes, it changes HERE first, then translators
 * catch up in js/locales/<other>.js.
 *
 * SHAPE: nested objects, dotted keys ('install.cardSub'). Values are:
 *   - a string, with {slots} for variable parts, OR
 *   - an array of strings (step lists), OR
 *   - a plural object { one, other, ... } selected by params.count.
 *
 * TONE (unchanged, non-negotiable): informal "kamu", Indonesian. See CLAUDE.md.
 *
 * SCOPE TODAY: only the strings already wired through t() — the install prompt.
 * The rest of the app still holds inline literals; they migrate here in the big
 * extraction sweep (deferred until feat/edit-teks-asli lands — see docs/i18n.md).
 * Keep this dictionary honest: no key that isn't actually read by t() somewhere.
 */
export default {
  install: {
    // {where} = device word (device.mobile | device.desktop)
    chip: 'Install PDFLokal di {where}',
    cardTitle: 'Install PDFLokal di {where}',
    // {screen} = where the icon lands (screen.mobile | screen.desktop)
    cardSub: 'Biar besok nggak usah nyari lagi — langsung ada di {screen}, tetap jalan walau lagi offline.',

    // The device word gets spliced mid-sentence — it MUST be a slot, never a
    // substring, because word order differs by language.
    device: { mobile: 'hapemu', desktop: 'komputermu' },
    screen: { mobile: 'layar HP', desktop: 'desktop' },

    // Per-browser manual install instructions. Titles + ordered step lists.
    ios: {
      title: 'Caranya di iPhone/iPad:',
      steps: [
        'Tap ikon Share (kotak dengan panah ke atas) di bawah.',
        'Scroll ke bawah, tap “Add to Home Screen”.',
        'Tap “Add” di kanan atas.',
      ],
    },
    androidFirefox: {
      title: 'Caranya di Firefox:',
      steps: [
        'Tap menu titik-tiga di kanan atas.',
        'Pilih “Install”.',
      ],
    },
    androidSamsung: {
      title: 'Caranya di Samsung Internet:',
      steps: [
        'Tap menu di bawah.',
        'Pilih “Add page to” → “Home screen”.',
      ],
    },
    androidChrome: {
      title: 'Caranya di Chrome:',
      steps: [
        'Tap menu titik-tiga di kanan address bar.',
        'Pilih “Add to Home screen”.',
        'Tap “Install”.',
      ],
    },
    desktopChromium: {
      title: 'Caranya di Chrome/Edge:',
      steps: [
        'Klik ikon Install (layar kecil dengan panah) di ujung kanan address bar, kalau ada.',
        'Atau: menu titik-tiga → “Cast, save, and share” → “Install page as app…”.',
        'Klik “Install”.',
      ],
    },
    desktopSafari: {
      title: 'Caranya di Safari (Mac):',
      steps: [
        'Dari menu “File”, pilih “Add to Dock”.',
        'Klik “Add”.',
      ],
    },
    fallback: {
      title: 'Biar gampang dibuka lagi:',
      steps: [
        'Tekan Ctrl+D (atau ⌘D) buat bookmark halaman ini.',
        'Atau buka pdflokal.id lewat Chrome/Edge buat install jadi app.',
      ],
    },
  },
};
