import { createHash } from 'node:crypto';

const ACTIVE = new Set(['ACTIVE_PRICED', 'ACTIVE_UNPRICED']);
const STATES = new Set(['ACTIVE_PRICED', 'ACTIVE_UNPRICED', 'INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE']);
const sha = value => createHash('sha256').update(value).digest('hex');
const sqlString = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;

function evidenceFor(row) {
  const first = Array.isArray(row.evidenceReferences) ? row.evidenceReferences[0] : null;
  return {
    evidenceSha256: first?.snapshotSha256 || null,
    reviewReference: first?.reviewReference || null,
  };
}

export function buildVariantResolutionActivationPlan(ledger, { classifiedAt = Date.now() } = {}) {
  if (ledger?.productionWrites !== false || ledger?.activationAuthorized !== false || !Array.isArray(ledger?.results)) {
    throw new Error('Expected a read-only PR #488 resolution ledger');
  }
  if (!Number.isFinite(classifiedAt)) throw new Error('classifiedAt must be explicit');
  const seen = new Set();
  const rows = ledger.results.map(row => {
    if (!row.cardIdentityId || !STATES.has(row.state)) throw new Error('Invalid resolution row');
    if (seen.has(row.cardIdentityId)) throw new Error('Duplicate activation identity');
    seen.add(row.cardIdentityId);
    const evidence = evidenceFor(row);
    if (row.state !== 'UNRESOLVED_EVIDENCE' && !evidence.evidenceSha256) throw new Error(`Resolved state requires pinned evidence: ${row.cardIdentityId}`);
    return {
      cardIdentityId: row.cardIdentityId,
      finish: row.variantCode,
      language: row.language,
      edition: row.edition,
      state: row.state,
      reason: row.reason,
      ...evidence,
      classifiedAt,
      action: ACTIVE.has(row.state) ? 'activate_identity_state'
        : row.state === 'INVALID_CATALOGUE_ENTRY' ? 'flag_invalid_no_delete'
          : 'hold_unresolved',
    };
  }).sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId));
  const counts = Object.fromEntries([...STATES].map(state => [state, rows.filter(row => row.state === state).length]));
  const canonical = JSON.stringify(rows);
  return {
    schemaVersion: 1,
    productionWrites: false,
    priceWrites: false,
    baseCardDeletes: false,
    counts,
    rows,
    deltaSha256: sha(canonical),
  };
}

export function renderDeltaActivationSql(plan) {
  if (plan?.productionWrites !== false || plan?.priceWrites !== false || plan?.baseCardDeletes !== false || !Array.isArray(plan?.rows)) {
    throw new Error('Unsafe activation plan');
  }
  const statements = ['BEGIN;', "SELECT pg_advisory_xact_lock(hashtext('fatedrop-variant-resolution-activation'));", ''];
  for (const row of plan.rows) {
    statements.push(`INSERT INTO fatedrop_variant_resolution_state (card_identity_id,finish,language,edition,classifier_state,reason,evidence_sha256,review_reference,classified_at,updated_at) VALUES (${sqlString(row.cardIdentityId)},${sqlString(row.finish)},${sqlString(row.language)},${sqlString(row.edition)},${sqlString(row.state)},${sqlString(row.reason)},${sqlString(row.evidenceSha256)},${sqlString(row.reviewReference)},${row.classifiedAt},${row.classifiedAt}) ON CONFLICT (card_identity_id) DO UPDATE SET finish=EXCLUDED.finish,language=EXCLUDED.language,edition=EXCLUDED.edition,classifier_state=EXCLUDED.classifier_state,reason=EXCLUDED.reason,evidence_sha256=EXCLUDED.evidence_sha256,review_reference=EXCLUDED.review_reference,classified_at=EXCLUDED.classified_at,updated_at=EXCLUDED.updated_at;`);
    if (row.state === 'INVALID_CATALOGUE_ENTRY') {
      const flagId = `fdflag_${sha(`${row.cardIdentityId}|invalid_catalogue_entry|${row.evidenceSha256}`).slice(0, 32)}`;
      statements.push(`INSERT INTO fatedrop_catalogue_audit_flags (id,card_identity_id,flag_type,reason,evidence_sha256,review_reference,active,created_at,resolved_at) VALUES (${sqlString(flagId)},${sqlString(row.cardIdentityId)},'invalid_catalogue_entry',${sqlString(row.reason)},${sqlString(row.evidenceSha256)},${sqlString(row.reviewReference)},TRUE,${row.classifiedAt},NULL) ON CONFLICT (id) DO NOTHING;`);
    }
    if (row.state === 'UNRESOLVED_EVIDENCE') {
      statements.push(`INSERT INTO fatedrop_variant_audit_hold (card_identity_id,finish,reason,evidence_sha256,active,created_at,updated_at,resolved_at) VALUES (${sqlString(row.cardIdentityId)},${sqlString(row.finish)},${sqlString(row.reason)},${sqlString(row.evidenceSha256)},TRUE,${row.classifiedAt},${row.classifiedAt},NULL) ON CONFLICT (card_identity_id) DO UPDATE SET finish=EXCLUDED.finish,reason=EXCLUDED.reason,evidence_sha256=EXCLUDED.evidence_sha256,active=TRUE,updated_at=EXCLUDED.updated_at,resolved_at=NULL;`);
    } else {
      statements.push(`UPDATE fatedrop_variant_audit_hold SET active=FALSE,updated_at=${row.classifiedAt},resolved_at=${row.classifiedAt} WHERE card_identity_id=${sqlString(row.cardIdentityId)} AND active=TRUE;`);
    }
  }
  statements.push('', '-- Price observations are intentionally not written here.', '-- Existing guarded Cardmarket ingestion remains the only price writer.', 'COMMIT;', '');
  const sql = statements.join('\n');
  if (/\bDELETE\s+FROM\s+fatedrop_card_/i.test(sql)) throw new Error('Base card deletion detected');
  if (/market_price\s*=|INSERT\s+INTO\s+fatedrop_cardmarket_price/i.test(sql)) throw new Error('Direct price write detected');
  return sql;
}
