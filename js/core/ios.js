/*
 * PDFLokal — core/ios.js  (is this an iPhone/iPad?)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for "iOS or not". It was a private function in
 * js/v2/install-prompt.js; the Unduh sheet now asks too (where did my file go:
 * the Files app on iOS, the Download folder everywhere else), and two copies of
 * this rule would eventually disagree about the same phone.
 *
 * Pure: takes the navigator's fields instead of reading `navigator`, so a node
 * test can hold it (tests/core/ios.test.mjs).
 *
 * WHY the MacIntel + touch clause: since iPadOS 13 Safari reports a Mac user
 * agent by default ("Request Desktop Website" is on for iPad). The tell is a
 * Mac platform with a touch screen, which no real Mac has.
 */
export function isIOS({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  return /iphone|ipad|ipod/i.test(userAgent)
    || (platform === 'MacIntel' && maxTouchPoints > 1);
}
