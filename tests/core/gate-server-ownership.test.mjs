/*
 * The full gate must own port 5050. If it reuses another session's server,
 * that session can end halfway through the suite and turn every remaining
 * navigation into ERR_CONNECTION_REFUSED while the product itself is fine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = fs.readFileSync(path.join(ROOT, 'scripts/qa-gate.mjs'), 'utf8');

async function configWith(gateOwnsServer) {
  const oldGate = process.env.PDFLOKAL_GATE_OWNS_SERVER;
  const oldCi = process.env.CI;
  delete process.env.CI;
  if (gateOwnsServer) process.env.PDFLOKAL_GATE_OWNS_SERVER = '1';
  else delete process.env.PDFLOKAL_GATE_OWNS_SERVER;

  try {
    const url = pathToFileURL(path.join(ROOT, 'playwright.config.js'));
    url.searchParams.set('ownership-test', gateOwnsServer ? 'gate' : 'local');
    return (await import(url.href)).default;
  } finally {
    if (oldGate === undefined) delete process.env.PDFLOKAL_GATE_OWNS_SERVER;
    else process.env.PDFLOKAL_GATE_OWNS_SERVER = oldGate;
    if (oldCi === undefined) delete process.env.CI;
    else process.env.CI = oldCi;
  }
}

test('the full gate owns its server; ordinary local runs may reuse one', async () => {
  const local = await configWith(false);
  const gate = await configWith(true);

  assert.equal(local.webServer.reuseExistingServer, true,
    'control failed: this test must distinguish the ordinary local policy');
  assert.equal(gate.webServer.reuseExistingServer, false,
    'the gate flag must disable reuse in Playwright config');
  assert.match(GATE, /PDFLOKAL_GATE_OWNS_SERVER:\s*'1'/,
    'qa-gate must actually set the ownership flag on its Playwright child');
});
