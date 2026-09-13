import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../../src/trader/catalogue/production-target-check.mjs';

const OPERATOR_OBSERVED_AT = Date.parse('2026-09-13T10:55:00Z');
const AUDIT_PATH = 'signal-engine/evidence/reviews/remaining-890-operator-audit-2026-09-13.json';
const completeness = Object.freeze({
  checklistComplete: true,
  sealedProductDecklistsCovered: true,
  paginationComplete: true,
  alternateDistributionCovered: true,
});
const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const norm = value => String(value ?? '').trim().toLowerCase();
const keyFor = row => `${norm(row.variant_code ?? row.variantCode)}:${norm(row.collector_number ?? row.collectorNumber)}`;

export function validateRemainingAudit(audit) {
  if (audit?.status !== 'operator_review_complete') throw new Error('Remaining audit is not operator-review complete');
  if (audit?.scope?.remainingReviewed !== 890 || audit?.scope?.sets !== 47) throw new Error('Remaining audit scope must be exactly 890 rows across 47 sets');
  if (audit?.scope?.exists !== 55 || audit?.scope?.doesNotExist !== 835) throw new Error('Remaining audit verdict totals must be 55 exists / 835 does_not_exist');
  if (!Array.isArray(audit.rules) || audit.rules.length !== 47) throw new Error('Expected exactly 47 reviewed set rules');
  const setNames = new Set();
  let rows = 0;
  let positives = 0;
  for (const rule of audit.rules) {
    if (!rule?.set || setNames.has(rule.set)) throw new Error(`Duplicate or missing set rule: ${rule?.set}`);
    setNames.add(rule.set);
    if (!Number.isSafeInteger(rule.count) || rule.count < 1) throw new Error(`Invalid count for ${rule.set}`);
    const variantTotal = Object.values(rule.variantCounts || {}).reduce((sum, value) => sum + Number(value), 0);
    if (variantTotal !== rule.count) throw new Error(`Variant count mismatch for ${rule.set}: ${variantTotal} != ${rule.count}`);
    const positive = new Set((rule.positive || []).map(norm));
    if (positive.size !== (rule.positive || []).length) throw new Error(`Duplicate positive key in ${rule.set}`);
    for (const positiveKey of positive) {
      const [variant] = positiveKey.split(':');
      if (!Object.hasOwn(rule.variantCounts, variant)) throw new Error(`Positive variant ${variant} is outside ${rule.set} scope`);
    }
    rows += rule.count;
    positives += positive.size;
  }
  if (rows !== 890) throw new Error(`Reviewed set rules sum to ${rows}, expected 890`);
  if (positives !== 55) throw new Error(`Reviewed positives sum to ${positives}, expected 55`);
  return { rows, sets: setNames.size, exists: positives, doesNotExist: rows - positives };
}

export function buildRemainingReviewedInput(rows, audit, auditRaw, observedAt = OPERATOR_OBSERVED_AT) {
  const summary = validateRemainingAudit(audit);
  if (!Array.isArray(rows) || rows.length !== 890) throw new Error(`Expected exact live unresolved remainder of 890, found ${rows?.length ?? 0}`);
  const uniqueIds = new Set(rows.map(row => row.card_identity_id));
  if (uniqueIds.size !== 890) throw new Error(`Expected 890 unique card identities, found ${uniqueIds.size}`);
  const ruleBySet = new Map(audit.rules.map(rule => [rule.set, rule]));
  const observedBySet = new Map();
  for (const row of rows) {
    const rule = ruleBySet.get(row.set_name);
    if (!rule) throw new Error(`Live unresolved identity belongs to unreviewed set ${row.set_name}: ${row.card_identity_id}`);
    if (row.language_code !== 'en') throw new Error(`Unexpected language ${row.language_code} for ${row.card_identity_id}`);
    if (!Object.hasOwn(rule.variantCounts, row.variant_code)) throw new Error(`Unexpected finish ${row.variant_code} for ${row.set_name} ${row.collector_number}`);
    if (!observedBySet.has(row.set_name)) observedBySet.set(row.set_name, { total: 0, variants: new Map(), keys: new Set() });
    const observed = observedBySet.get(row.set_name);
    observed.total += 1;
    observed.variants.set(row.variant_code, (observed.variants.get(row.variant_code) || 0) + 1);
    const rowKey = keyFor(row);
    if (observed.keys.has(rowKey)) throw new Error(`Duplicate set/finish/collector key ${row.set_name} ${rowKey}`);
    observed.keys.add(rowKey);
  }
  for (const rule of audit.rules) {
    const observed = observedBySet.get(rule.set);
    if (!observed || observed.total !== rule.count) throw new Error(`Live count mismatch for ${rule.set}: ${observed?.total ?? 0} != ${rule.count}`);
    for (const [variant, expected] of Object.entries(rule.variantCounts)) {
      const actual = observed.variants.get(variant) || 0;
      if (actual !== expected) throw new Error(`Live ${variant} count mismatch for ${rule.set}: ${actual} != ${expected}`);
    }
    for (const positiveKey of rule.positive || []) {
      if (!observed.keys.has(norm(positiveKey))) throw new Error(`Reviewed positive is missing from live unresolved cohort: ${rule.set} ${positiveKey}`);
    }
  }

  const operatorAuditSha256 = sha256(auditRaw);
  const sourceLocator = `repo:${AUDIT_PATH}#sha256=${operatorAuditSha256}`;
  const reviews = rows.map(row => {
    const rule = ruleBySet.get(row.set_name);
    const exists = new Set((rule.positive || []).map(norm)).has(keyFor(row));
    const finding = exists
      ? `Operator audit confirms the exact ${row.variant_code} printing exists for ${row.set_name} ${row.collector_number} ${row.card_name} after complete set and ancillary-product review.`
      : `Operator audit confirms no physical ${row.variant_code} printing exists for ${row.set_name} ${row.collector_number} ${row.card_name} after complete set and ancillary-product review.`;
    return {
      cardIdentityId: row.card_identity_id,
      finish: row.variant_code,
      language: 'en',
      edition: 'unspecified',
      verdict: exists ? 'exists' : 'does_not_exist',
      basis: 'exact_printing_checklist',
      sourceLocator,
      observedAt,
      observedFinish: row.variant_code,
      evidencePayload: {
        cardIdentityId: row.card_identity_id,
        set: row.set_name,
        collectorNumber: row.collector_number,
        cardName: row.card_name,
        targetFinish: row.variant_code,
        operatorAuditPath: AUDIT_PATH,
        operatorAuditSha256,
        sourceSummary: rule.sourceSummary,
        finding,
        ...(exists ? {} : { completeness }),
      },
    };
  });
  const exists = reviews.filter(row => row.verdict === 'exists').length;
  const doesNotExist = reviews.length - exists;
  if (exists !== summary.exists || doesNotExist !== summary.doesNotExist) {
    throw new Error(`Generated verdict split ${exists}/${doesNotExist} does not match operator audit ${summary.exists}/${summary.doesNotExist}`);
  }
  return {
    provider: 'set_rule',
    reviewer: audit.reviewer,
    approvalReference: 'remaining-890-finish-review-2026-09-13',
    reviews,
  };
}

async function loadLiveUnresolvedFrozenRows(db, frozenAudit) {
  const frozen = frozenAudit.held
    .filter(row => row.reason === 'external_target_finish_absent')
    .map(row => row.cardIdentityId);
  if (frozen.length !== 1121 || new Set(frozen).size !== 1121) throw new Error(`Frozen cohort must contain exactly 1121 unique target identities, found ${frozen.length}`);
  const { rows } = await db.query(`
    SELECT r.card_identity_id,i.variant_code,i.language_code,i.collector_number,
           s.name AS set_name,p.name AS card_name
    FROM fatedrop_variant_resolution_state r
    JOIN fatedrop_card_identities i ON i.id=r.card_identity_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE r.classifier_state='UNRESOLVED_EVIDENCE'
      AND r.card_identity_id=ANY($1::text[])
    ORDER BY s.name,i.variant_code,i.collector_number,i.id`, [frozen]);
  return rows;
}

async function main() {
  const frozenAuditPath = process.argv[2];
  const operatorAuditPath = process.argv[3];
  const outputPath = process.argv[4];
  if (!frozenAuditPath || !operatorAuditPath || !outputPath) {
    throw new Error('Usage: node remaining-890-finish-2026-09-13.mjs frozen-audit.json operator-audit.json output.json');
  }
  if (process.env.PRICE_WRITE === 'true') throw new Error('Remaining finish evidence generation never writes prices');
  validateProductionTarget(process.env.DATABASE_URL);
  const [frozenRaw, operatorRaw] = await Promise.all([
    readFile(frozenAuditPath, 'utf8'),
    readFile(operatorAuditPath, 'utf8'),
  ]);
  const frozenAudit = JSON.parse(frozenRaw);
  const operatorAudit = JSON.parse(operatorRaw);
  validateRemainingAudit(operatorAudit);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    const rows = await loadLiveUnresolvedFrozenRows(db, frozenAudit);
    const input = buildRemainingReviewedInput(rows, operatorAudit, operatorRaw);
    await writeFile(outputPath, JSON.stringify(input, null, 2));
    const exists = input.reviews.filter(row => row.verdict === 'exists').length;
    console.log(JSON.stringify({ reviews: input.reviews.length, exists, doesNotExist: input.reviews.length - exists, operatorAuditSha256: sha256(operatorRaw) }));
  } finally {
    db.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
