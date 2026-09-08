import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductionTarget } from '../src/trader/catalogue/production-target-check.mjs';

const target = 'postgresql://fixture:fake-password@ep-wild-lake-ax1q3qxf-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require';
test('accepts only the verified production endpoint and database with TLS', () => {
  assert.equal(validateProductionTarget(target), true);
  assert.equal(validateProductionTarget(target.replace('-pooler', '')), true);
  for (const invalid of [undefined, 'bad credential', target.replace('ep-wild-lake', 'ep-other'), target.replace('/neondb', '/other'), target.replace('sslmode=require', 'sslmode=disable'), target.replace('postgresql:', 'https:'), target.replace(':fake-password', '')]) {
    assert.throws(() => validateProductionTarget(invalid));
  }
});
test('validation errors never contain the supplied credential', () => {
  const secret = 'postgresql://owner:do-not-log-this@wrong.invalid/neondb';
  assert.throws(() => validateProductionTarget(secret), error => !error.message.includes(secret) && !error.message.includes('do-not-log-this'));
});
test('rejects connection query overrides and duplicate TLS settings', () => {
  for (const extra of ['&host=wrong.invalid', '&sslmode=disable', '&sslrootcert=bad', '&database=other']) {
    assert.throws(() => validateProductionTarget(target + extra));
  }
});
