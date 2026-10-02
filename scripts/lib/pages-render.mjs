/*
 * pages-render.mjs — render a .docx with Apple Pages (a second consumer besides LibreOffice).
 * ============================================================================
 *   pagesAvailable() -> bool            macOS with /Applications/Pages.app
 *   renderWithPages(docx, pdf, { timeout }) -> { ok, ms, error?, stuck? }   stuck: timed out and Pages was NOT ours to kill, so it still sits behind its dialog: stop asking   open, export as PDF, close; one file at a time
 *   quitPages()                         quits Pages only if THIS process launched it (never a session the user had open)
 *
 * MEASURED 2026-10-02 (Pages 14.4, macOS 26.5.1): osascript -e 'tell application "Pages" ... open POSIX file ... export ... as PDF'
 * works with no Automation prompt on this Mac (22.8 s for the first file, which includes launching Pages), and
 * Pages renders table fills, page-background shapes, pictures, bullets and tab leaders from our output.
 *
 * WHAT IT IS NOT: Word. Pages is a different layout engine (its own line breaking, its own font substitution) and it
 * is more forgiving than Word about malformed packages. A green here is a second witness, never "opens in Word".
 *
 * FAILURE MODES, all reported as { ok: false, error } and never retried:
 *   - a TCC "Pages wants to control..." prompt (osascript -1743): the call times out; nobody is waiting to click it
 *   - a modal sheet inside Pages (missing fonts, "this document has features Pages does not support"): the call
 *     blocks until the timeout, then Pages is killed (only if this process launched it) and relaunched for the next file
 *   - a crash: osascript returns an error
 * Serial by nature (one app, one document at a time) and it steals focus: opt-in (--pages N) in docx-gate.mjs.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const pagesAvailable = () => process.platform === 'darwin' && fs.existsSync('/Applications/Pages.app');

let launchedByUs = false;
const running = () => spawnSync('pgrep', ['-x', 'Pages']).status === 0;
const q = (p) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function renderWithPages(docx, pdf, { timeout = 90000 } = {}) {
  if (!pagesAvailable()) return { ok: false, ms: 0, error: 'Pages is not installed' };
  if (!running()) launchedByUs = true;
  fs.rmSync(pdf, { force: true });
  const script = `tell application "Pages"
  set d to open POSIX file "${q(docx)}"
  delay 1
  export d to POSIX file "${q(pdf)}" as PDF
  close d saving no
end tell`;
  const t0 = Date.now();
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  const ms = Date.now() - t0;
  if (r.error || r.status !== 0 || !fs.existsSync(pdf)) {
    const timedOut = r.signal === 'SIGKILL' || (r.error && /ETIMEDOUT/.test(String(r.error)));
    // kill only a Pages THIS process launched: a session the person already had open, with their own documents, is never ours to kill
    const killed = timedOut && launchedByUs;
    if (killed) spawnSync('pkill', ['-x', 'Pages']);
    return { ok: false, ms, stuck: timedOut && !killed, error: timedOut ? `timeout after ${timeout} ms (a dialog or a permission prompt?)${killed ? ', Pages killed' : ', Pages left running (it was already open)'}` : String(r.stderr || r.error || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200) };
  }
  return { ok: true, ms };
}

export function quitPages() {
  if (!launchedByUs || !running()) return;
  spawnSync('osascript', ['-e', 'tell application "Pages" to quit saving no'], { timeout: 20000 });
  launchedByUs = false;
}
