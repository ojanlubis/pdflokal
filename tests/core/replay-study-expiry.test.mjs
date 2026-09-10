/*
 * THE SESSION-REPLAY STUDY HAS AN END DATE, AND THIS IS WHAT ENFORCES IT.
 * ============================================================================
 * Mixpanel's recorder was turned on for a ONE-MONTH UX study of the editor's
 * edit flow (seat decisions.md 2026-09-10). It ends **2026-10-10**, and "ends"
 * means the `record_*` keys come out of index.html's head, `cdn.mxpnl.com`
 * comes out of vercel.json's script-src, and this file is deleted with them.
 * The event fan-out in js/lib/analytics.js stays.
 *
 * WHY A TEST AND NOT A TODO ROW. This seat's own doctrine is that a queue item
 * is not a watcher: the thing that stops a temporary measure becoming a
 * permanent one is a check that goes red on its own. A recorder nobody
 * remembered to remove is a third party silently receiving user-derived data
 * from a product whose whole promise is that nothing leaves the device, and it
 * would fail quietly for exactly as long as nobody looked.
 *
 * ⚠️ THIS TEST IS *SUPPOSED* TO GO RED ONE DAY. When it does, the fix is to do
 * the removal, not to move the date. Moving the date is a decision, and a
 * decision belongs in the seat's decisions.md with a why — if the study is
 * genuinely being extended, extend it there first and change DEADLINE second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Midnight WIB (UTC+7) on the morning after the study's last day.
const DEADLINE = Date.parse('2026-10-11T00:00:00+07:00');

test('the Mixpanel recorder is gone by 2026-10-10, or this fails', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const csp = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  const recorderPresent = html.includes('record_sessions_percent');
  const cdnPresent = csp.includes('cdn.mxpnl.com');

  if (Date.now() < DEADLINE) {
    // Before the deadline the study is live, so this file's only job is to
    // prove it is still pointed at something real. A guard whose subject has
    // already been renamed would sail past the deadline saying nothing.
    assert.equal(
      recorderPresent, true,
      'record_sessions_percent is not in index.html. Either the recorder was removed early (then '
      + 'delete this file too) or the config key was renamed and this expiry guard is now inert.',
    );
    return;
  }

  assert.equal(
    recorderPresent, false,
    'THE SESSION-REPLAY STUDY EXPIRED ON 2026-10-10 AND THE RECORDER IS STILL ON. Remove the '
    + 'record_* keys from index.html\'s Mixpanel init, run `npm run seo`, and delete '
    + 'tests/mixpanel-replay-privacy.spec.js\'s replay half. Keep mixpanel.init and the track() '
    + 'fan-out. Then delete this file.',
  );
  // The unmask allowlist is one of the record_* keys and comes out with them.
  // Named separately because it is the newest and the easiest to overlook: it
  // was added 2026-09-10 (later) so pdflokal's own chrome stays readable, and
  // an orphaned unmask selector left behind after `record_mask_all_text` is
  // gone would be a masking config nobody has read.
  assert.equal(
    html.includes('record_unmask_text_selector'), false,
    'The recorder is out but record_unmask_text_selector is still in index.html. It is part of the '
    + 'study\'s masking config: delete it with the rest of the record_* keys and run `npm run seo`.',
  );
  assert.equal(
    cdnPresent, false,
    'The recorder is out of index.html but cdn.mxpnl.com is still in vercel.json\'s script-src. '
    + 'If Mixpanel events are still wanted, the SDK still loads from there and this line stays: '
    + 'delete this file instead. If Mixpanel is gone entirely, take the host out too.',
  );
});
