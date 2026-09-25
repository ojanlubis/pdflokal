// api/cron/* must refuse everyone but Vercel Cron, and must FAIL CLOSED when
// CRON_SECRET is missing — a missing secret may never make a job public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronAuthorized } from '../../api/_cron.js';

const req = (h) => ({ headers: h === undefined ? {} : { authorization: h } });

test('cronAuthorized: only the exact bearer passes', () => {
  assert.equal(cronAuthorized(req('Bearer s3cret'), 's3cret'), true);
  assert.equal(cronAuthorized(req('Bearer wrong!'), 's3cret'), false);
  assert.equal(cronAuthorized(req('s3cret'), 's3cret'), false);
  assert.equal(cronAuthorized(req(), 's3cret'), false);
});

test('cronAuthorized: no secret configured refuses everyone, even a matching empty bearer', () => {
  assert.equal(cronAuthorized(req('Bearer '), ''), false);
  assert.equal(cronAuthorized(req('Bearer undefined'), undefined), false);
});
