/*
 * PDFLokal — locales/en.js  (English)
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
    initialsSelected: 'Initials selected',
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
    armInitials: 'Pick a spot to place the initials',
    armEdit: 'Edit original text, a beta feature. Tap the text you want to change',
    armEditShort: 'Tap the text you want to change',
    missedText: 'Missed the text. Tap right on it',
    noReadableText: 'No readable text found',
    scanFailed: 'Scan failed. Try again',
    scanNotEditable: "This page is a scan or photo, so its text can't be edited yet",
    pickObject: 'Pick the object you want to delete',
    preparing: 'One moment, getting ready',
    fontSubstituteResult: 'Some text uses a similar substitute font in the saved file',
    fontSubstituteChar: 'This character uses a similar substitute font',
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
    merged: {
      one: 'Merged, now {count} page',
      other: 'Merged, now {count} pages',
    },
    addMoreFiles: 'Add more files from the File menu, top left',
  },
};
