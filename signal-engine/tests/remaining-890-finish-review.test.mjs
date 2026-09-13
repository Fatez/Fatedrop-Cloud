import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRemainingReviewedInput, validateRemainingAudit } from '../evidence/reviews/remaining-890-finish-2026-09-13.mjs';
import { buildReviewedDecisionManifest } from '../src/trader/value/reviewed-finish-decision-cli.mjs';

const auditUrl = new URL('../evidence/reviews/remaining-890-operator-audit-2026-09-13.json', import.meta.url);

function syntheticRows(audit) {
  const rows = [];
  let identity = 0;
  for (const rule of audit.rules) {
    const positivesByVariant = new Map();
    for (const positiveKey of rule.positive || []) {
      const [variant, collector] = positiveKey.split(':');
      positivesByVariant.set(variant, (positivesByVariant.get(variant) || 0) + 1);
      rows.push({
        card_identity_id: `fdcard_synthetic_${identity++}`,
        variant_code: variant,
        language_code: 'en',
        collector_number: collector,
        set_name: rule.set,
        card_name: `Synthetic positive ${rule.set} ${collector}`,
      });
    }
    for (const [variant, expected] of Object.entries(rule.variantCounts)) {
      const remaining = expected - (positivesByVariant.get(variant) || 0);
      for (let i = 0; i < remaining; i += 1) {
        rows.push({
          card_identity_id: `fdcard_synthetic_${identity++}`,
          variant_code: variant,
          language_code: 'en',
          collector_number: `synthetic-${rule.set}-${variant}-${i}`,
          set_name: rule.set,
          card_name: `Synthetic negative ${rule.set} ${i}`,
        });
      }
    }
  }
  return rows;
}

test('remaining 890 operator audit is exact, complete and snapshot-unique', async () => {
  const auditRaw = await readFile(auditUrl, 'utf8');
  const audit = JSON.parse(auditRaw);
  assert.deepEqual(validateRemainingAudit(audit), { rows: 890, sets: 47, exists: 55, doesNotExist: 835 });
  assert.equal(audit.normalizations[0].productionSet, 'Deoxys');

  const rows = syntheticRows(audit);
  assert.equal(rows.length, 890);
  const input = buildRemainingReviewedInput(rows, audit, auditRaw, 1789296900000);
  assert.equal(input.provider, 'set_rule');
  assert.equal(input.reviews.length, 890);
  assert.equal(new Set(input.reviews.map(row => row.cardIdentityId)).size, 890);
  assert.equal(input.reviews.filter(row => row.verdict === 'exists').length, 55);
  assert.equal(input.reviews.filter(row => row.verdict === 'does_not_exist').length, 835);
  for (const row of input.reviews.filter(row => row.verdict === 'does_not_exist')) {
    assert.equal(row.basis, 'exact_printing_checklist');
    assert.equal(row.evidencePayload.completeness.checklistComplete, true);
    assert.equal(row.evidencePayload.completeness.sealedProductDecklistsCovered, true);
    assert.equal(row.evidencePayload.completeness.paginationComplete, true);
    assert.equal(row.evidencePayload.completeness.alternateDistributionCovered, true);
  }

  const reviewed = buildReviewedDecisionManifest(input);
  assert.equal(reviewed.decisions.length, 890);
  assert.equal(new Set(reviewed.decisions.map(row => row.snapshotSha256)).size, 890);
  assert.equal(Object.keys(reviewed.snapshots).length, 890);
  assert.equal(reviewed.productionWrites, false);
  assert.equal(reviewed.priceWrites, false);
  assert.equal(reviewed.policy.noBaseCardDeletes, true);
});
