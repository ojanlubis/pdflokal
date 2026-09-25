// The backfill's proof is a fingerprint compared across two stores whose raw
// JSON text differs (Postgres jsonb reorders keys, the live writer does not).
// canon() must make key order irrelevant and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canon, fingerprint } from '../../api/cron/backfill.js';

test('canon: key order is irrelevant at every depth', () => {
  assert.equal(canon({ b: 1, a: { d: [1, { z: 1, y: 2 }] } }), canon({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test('canon: a changed value, type or array order is NOT hidden', () => {
  assert.notEqual(canon({ a: 1 }), canon({ a: '1' }));
  assert.notEqual(canon({ a: [1, 2] }), canon({ a: [2, 1] }));
  assert.notEqual(canon({ a: null }), canon({}));
});

test('fingerprint: row order and content both count', () => {
  assert.notEqual(fingerprint(['a', 'b']), fingerprint(['b', 'a']));
  assert.equal(fingerprint(['a', 'b']), fingerprint(['a', 'b']));
});
