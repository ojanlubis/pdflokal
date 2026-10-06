/*
 * PDFLokal - locales/en.js  (English)
 * ============================================================================
 * Same keys as id.js (tests/core/i18n.test.mjs fails on any difference, and on
 * a different {slot} set). Plain, short, friendly product English: the meaning
 * of the Indonesian, not a word-for-word copy. No em-dashes. Tool names:
 * Edit, Download, Sign, Whiteout, Merge, Compress, Pages. The brand stays
 * "PDFLokal". Where Indonesian counts something, English uses { one, other }.
 *
 * Success lines carry no exclamation mark here (house copy rule); id keeps its
 * own. Promises (privacy, "not uploaded") say exactly what the Indonesian says.
 */
export default {
  number: {
    decimal: '.',
  },

  page: { short: 'Page {n}' },
  loading: { count: '{n} of {total} files' },

  sigBar: {
    signatureSelected: 'Signature selected',
    armed: 'Pick a spot to place',
  },

  landing: {
    hideTools: 'Hide',
    showTools: 'See all tools',
  },

  toast: {
    armText: 'Pick a spot to write',
    armWhiteout: 'Drag on the page to cover text',
    armSignature: 'Pick a spot to place the signature',
    armEdit: 'Edit original text, a beta feature. Tap the text you want to change',
    armEditShort: 'Tap the text you want to change',
    missedText: 'Missed the text. Tap right on it',
    notText: "No text there. If it's a picture, use Whiteout.",
    lineNoWrap: "This line can't wrap, so it runs wider.",
    armEditLocked: "This PDF is locked, edits can't be downloaded.",
    armEditSigned: 'Has a digital signature or e-stamp. Editing voids it.',
    charRefused: '"{ch}" can\'t be written, the font doesn\'t have it.',
    noReadableText: 'No readable text found',
    scanFailed: 'Scan failed. Try again',
    scanNotEditable: "This page is a scan or photo, so its text can't be edited yet",
    pickObject: 'Pick the object you want to delete',
    preparing: 'One moment, getting ready',
    fontSubstituteResult: 'Some text uses a similar substitute font in the saved file',
    fontSubstituteChar: "Original font can't be reused, so a lookalike is used.",
    blockGrew: 'The paragraph is now longer than before and overlaps the text below it.',
    extractDone: {
      one: 'Done. {count} page extracted into a new PDF',
      other: 'Done. {count} pages extracted into a new PDF',
    },
    extractFailed: "Couldn't extract the pages. Try again",
    signatureReplaced: 'Signature replaced',
    signatureCopied: {
      one: 'Placed on {count} other page too',
      other: 'Placed on {count} other pages too',
    },
    stillLoading: 'One moment, the previous file is still loading',
    pickFile: 'Pick a PDF or image file',
    tooBig: '"{name}" is too big (max 100MB)',
    lockedReadOnly: "This PDF is locked. It can be read, but can't be saved again",
    openLocked: "That file is password-protected, so it can't be opened here",
    openFailedOne: "That file can't be opened. It may be empty or damaged",
    openFailedAll: "None of those files can be opened. They may be empty or damaged",
    openFailed: "Couldn't open the file",
    skipped: {
      one: "{count} file skipped, it's empty or damaged",
      other: "{count} files skipped, they're empty or damaged",
    },
    mergeBlocked: "The open PDF can't be combined with other files",
    merged: {
      one: 'Merged, now {count} page',
      other: 'Merged, now {count} pages',
    },
    addMoreFiles: 'Add more files from the File menu, top left',
  },

  sheet: {
    fail: {
      retry: "Couldn't create the file. Try again",
      encrypted: "This PDF is locked, so it can't be saved again",
      corrupt: "This PDF is damaged, so it can't be rebuilt",
      unsupported: "Some characters can't be saved. Check the text you wrote",
      unknown: "Couldn't create the file",
    },
    signedNote: "This document has a meterai (Indonesian stamp duty seal) or a digital signature. If you save it from here, the seal breaks and the document may fail verification. Your original file doesn't change.",
    coveredNote: 'Covered text is still in the file. For anything private, download as Image.',
    auto: 'Auto',
    compressFailed: 'Compress failed, using the original size',
    meta: {
      one: '{name}.pdf · {count} page',
      other: '{name}.pdf · {count} pages',
    },
    pagesAll: {
      one: '{count} page',
      other: '{count} pages',
    },
    pagesPicked: '{count} selected',
    stamp: { optimal: 'Already optimal' },
    progress: {
      search: 'Finding the right size… (attempt {pass})',
      images: 'Preparing images {done}/{total}…',
      zip: 'Packing into a ZIP…',
    },
    size: {
      original: 'Original',
      medium: 'Medium',
      small: 'Small',
      compress: 'Compress',
      smaller: 'smaller file',
      calculating: 'calculating…',
      optimal: 'file already optimal',
      saved: 'saves {pct}%',
    },
    cta: {
      pdf: 'Download PDF',
      pages: {
        one: '({count} page)',
        other: '({count} pages)',
      },
      imageOne: 'Download 1 Image',
      imageZip: 'Download {count} Images · ZIP',
    },
    sub: {
      missed: "smallest possible: {size}, still over {cap}. Try removing pages you don't need.",
      fits: '{size}, fits under {cap}',
      saved: 'saves {pct}% of {size}',
      alreadySmallest: "already as small as it gets, can't be compressed further without damaging it",
      originalSize: 'original size',
    },
    toast: {
      zipDone: {
        one: 'Done. {count} image packed into one ZIP',
        other: 'Done. {count} images packed into one ZIP',
      },
    },
  },

  intent: {
    gabung: {
      dzTitle: 'Drag in all the PDFs you want to merge',
      dzHint: 'Add as many files as you like, you can set the order next',
      pmTitle: 'Set Order',
      pmHint: "Hold, then drag to reorder · delete pages you don't need",
    },
    split: {
      dzTitle: 'Drag in the PDF you want to split',
      dzHint: 'Next, check the pages you want to take',
      pmTitle: 'Select Pages',
      pmHint: 'Check the pages you want to split into a new PDF file',
      extract: 'Split',
    },
    halaman: {
      dzTitle: 'Drag in the PDF whose pages you want to tidy up',
      dzHint: 'Delete blank pages, reorder, rotate the tilted ones',
      pmTitle: 'Manage Pages',
      pmHint: 'Check the pages you want to delete',
    },
    kompres: {
      dzTitle: 'Drag in the PDF you want to compress',
      dzHint: 'You see the result size before you download',
    },
    ttd: {
      dzTitle: 'Drag in the PDF you want to sign',
      dzHint: 'Next, you can draw your signature or use a photo of it',
    },
    paraf: {
      dzTitle: 'Drag in the PDF you want to initial',
      dzHint: 'Initials can be copied to every page at once',
    },
    teks: {
      dzTitle: 'Drag in the PDF you want to add text to',
      dzHint: 'Tap anywhere on the page to start writing',
    },
    tipex: {
      dzTitle: 'Drag in the PDF with text you want to cover',
      dzHint: 'Drag over the wrong part, like whiteout on paper',
    },
    gambar: {
      dzTitle: 'Drag in the PDF you want to turn into images',
      dzHint: 'Each page becomes one JPG or PNG file',
    },
    foto: {
      dzTitle: 'Drag in the photos you want to turn into a PDF',
      dzHint: 'Add as many as you like, you can set the order next',
      pmTitle: 'Set Order',
      pmHint: 'Hold, then drag to reorder · rotate tilted photos',
    },
  },

  install: {
    chip: 'Install PDFLokal on {where}',
    cardTitle: 'Install PDFLokal on {where}',
    cardSub: "No need to search for it again tomorrow, it's right on {screen} and works offline.",
    device: { mobile: 'your phone', desktop: 'your computer' },
    screen: { mobile: 'your phone screen', desktop: 'your desktop' },
    guideLang: 'en',
    ios: {
      title: 'Steps on iPhone/iPad:',
      steps: [
        'Tap the Share icon (a box with an arrow pointing up) at the bottom.',
        'Scroll down, tap “Add to Home Screen”.',
        'Tap “Add” at the top right.',
      ],
    },
    androidFirefox: {
      title: 'Steps on Firefox:',
      steps: [
        'Tap the three-dot menu at the top right.',
        'Choose “Install”.',
      ],
    },
    androidSamsung: {
      title: 'Steps on Samsung Internet:',
      steps: [
        'Tap the menu at the bottom.',
        'Choose “Add page to” → “Home screen”.',
      ],
    },
    androidChrome: {
      title: 'Steps on Chrome:',
      steps: [
        'Tap the three-dot menu to the right of the address bar.',
        'Choose “Add to Home screen”.',
        'Tap “Install”.',
      ],
    },
    desktopChromium: {
      title: 'Steps on Chrome/Edge:',
      steps: [
        'Click the Install icon (a small screen with an arrow) at the right end of the address bar, if you see it.',
        'Or: three-dot menu → “Cast, save, and share” → “Install page as app…”.',
        'Click “Install”.',
      ],
    },
    desktopSafari: {
      title: 'Steps on Safari (Mac):',
      steps: [
        'From the “File” menu, choose “Add to Dock”.',
        'Click “Add”.',
      ],
    },
    fallback: {
      title: "So it's easy to open again:",
      steps: [
        'Press Ctrl+D (or ⌘D) to bookmark this page.',
        'Or open pdflokal.id in Chrome/Edge to install it as an app.',
      ],
    },
  },

  editFeedback: {
    ask: 'How did the edit turn out?',
    up: 'Good',
    down: 'Not quite right',
    thanks: 'Thanks, your feedback helps me 🙏',
    noteQuestion: "What's not quite right?",
    notePlaceholder: 'add feedback so we can improve',
    noteLabel: "Tell us what's not quite right",
    askTitle: 'Can I have these two crops?',
    askSub: 'Before and after, so I can analyse where the feature falls short. Nothing else from the file is included.',
    cropBefore: 'Before',
    cropAfter: 'After',
    skip: 'No thanks',
    send: 'Send',
  },

  sig: {
    pickImage: 'Pick an image file',
    readFailed: "Couldn't read the image",
    drawFirst: 'Draw your signature first',
    uploadFirst: 'Upload an image of your signature first',
    empty: 'The signature is empty',
  },

  celebrate: {
    shareText: "Hey, try pdflokal.id. You can edit and sign PDFs right on your phone. It's free, and your files aren't uploaded anywhere.",
    stampOffline: 'Still works',
    stampDone: 'Done ✓',
    offlineToast: "Internet connection lost. Don't worry, everything runs on your phone, not on a server.",
    neverToast: "Okay, it won't show up again",
    copiedToast: 'Copied, just send it to your friend',
  },

  playstore: {
    thanksNo: 'Okay, thanks for the feedback',
    thanksLater: 'Got it, thanks',
  },

  format: {
    font: 'Font',
    size: 'Font size',
    bold: 'Bold',
    italic: 'Italic',
    color: 'Color {color}',
    moreColors: 'More colors',
  },

  pm: {
    page: 'Page {n}',
    moveUp: 'Move up',
    moveDown: 'Move down',
    rotate: 'Rotate',
    delete: 'Delete page',
    use: 'Use ({n})',
    selected: '{count} selected',
    deleted: {
      one: '{count} page deleted. Wrong one? Just Undo',
      other: '{count} pages deleted. Wrong ones? Just Undo',
    },
  },

  bugPrompt: {
    small: 'Hello, PDFLokal user',
    big: 'Please let me know about any bugs, here',
  },

  // The feature vote card. Written from the same facts as id.js, not translated word
  // for word; all DRAFT until he reads them (the step-1 and after-vote lines follow
  // his casual tone: his Indonesian is the source).
  featureVote: {
    inviteTitle: 'Feature vote',
    invite: "Hey guys. I want to build a new feature but I can't decide what. Help me vote pleaseee. thankss",
    start: 'Pick features',
    later: 'Maybe later',
    title: 'Which features do you need?',
    hint: 'Pick up to 3',
    picked: '{n} of {max} picked',
    idea: 'Not here yet? Just write it',
    send: 'Send my picks',
    failed: "Your picks didn't go through. Try again.",
    thanks: "Thanks for votingg. When it's done I'll tell you here ok",
    top: 'Most picked so far:',
    close: 'Close',
    shipped: "{feature} is done. You're one of the people who picked it, thankss",
    labels: [
      'PDF to Word',
      'PDF to Excel',
      'Save your edits to continue later',
      'Lock and unlock password-protected PDFs',
      'Fill in PDF forms',
      'Scan documents with your phone camera',
      'Add an image or logo',
      'Add a watermark',
    ],
  },

  render: { loading: 'loading…' },

  maker: {
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },

  theme: {
    toLight: 'Switch to light mode',
    toDark: 'Switch to dark mode',
  },
};
