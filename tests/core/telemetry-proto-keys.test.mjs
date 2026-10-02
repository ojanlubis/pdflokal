// validateEvent must answer from the schema's OWN keys. SCHEMA is a plain object,
// so `SCHEMA['constructor']` used to resolve to Object.prototype.constructor (a
// function): truthy, zero declared props, and the event validated and was stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../../js/core/telemetry-schema.js';

for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
  test(`event name "${name}" is unknown, not valid`, () => {
    assert.deepEqual(validateEvent(name, {}), { ok: false, reason: 'unknown_event' });
  });
}

test('a prop named after a prototype key is unknown, not silently accepted', () => {
  const r = validateEvent('zoom_tap', { toString: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_prop');
});
