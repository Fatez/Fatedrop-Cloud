import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const TARGET_SOURCE_VARIANT = Object.freeze({ standard: 'normal', holo: 'holo' });
const TARGET_PRICE_LANE = Object.freeze({ standard: 'standard', holo: 'holo' });
const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');

function positiveStoredPriceSql(alias = 'o') {
  return `GREATEST(
    COALESCE(${alias}.market_price,0),
    COALESCE(${alias}.trend_price,0),
    COALESCE(${alias}.avg_1d,0),
    COALESCE(${alias}.avg_7d,0),
    COALESCE(${alias}.avg_30d,0)
  ) > 0`;
}

function compactPriceRow(row) {
  if (!row) return null;
  return {
    idProduct: row.idProduct ?? null,
    trend: row.trend ?? null,
    avg1: row.avg1 ?? null,
    avg7: row.avg7 ?? null,
    avg30: row.avg30 ?? null,
    trendHolo: row['trend-holo'] ?? null,
    avg1Holo: row['avg1-holo'] ?? null,
    avg7Holo: row['avg7-holo'] ?? null,
    avg30Holo: row['avg30-holo'] ?? null,
  };
}

function rejectionProviderRow(rejection) {
  const raw = rejection?.raw_payload;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.row && typeof raw.row === 'object') return raw.row;
  return null;
}

function increment(object, name) {
  object[name] = (object[name] || 0) + 1;
}

async function build(db) {
  const { rows: identities } = await db.query(`
    SELECT i.id AS card_identity_id,
           i.printing_id,
           i.set_id,
           i.variant_code,
           p.name,
           p.collector_number,
           s.name AS set_name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.card_identity_id=i.id
          AND o.source_name='cardmarket'
          AND ${positiveStoredPriceSql('o')}
      )
    ORDER BY i.variant_code, s.name, p.collector_number, i.id`);

  const identityIds = identities.map((row) => row.card_identity_id);
  if (identityIds.length === 0) {
    return {
      status: 'audit_complete',
      productionWrites: false,
      counts: { mappedWithoutPositivePrice: 0 },
      classes: {},
      rows: [],
    };
  }

  const { rows: mappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key,source_version,
           first_observed_at,last_observed_at
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND card_identity_id=ANY($1::text[])
    ORDER BY card_identity_id,source_variant_key,source_record_id`, [identityIds]);

  const productIds = [...new Set(mappings.map((row) => String(row.source_record_id)))];
  const { rows: owners } = await db.query(`
    SELECT source_record_id,source_variant_key,
           array_agg(DISTINCT card_identity_id ORDER BY card_identity_id) AS owners
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND source_record_id=ANY($1::text[])
    GROUP BY source_record_id,source_variant_key`, [productIds]);

  const { rows: rejections } = await db.query(`
    SELECT source_record_id,source_variant_key,rejection_code,rejection_detail,raw_payload,created_at,source_snapshot_id
    FROM fatedrop_market_ingest_rejections
    WHERE source_name='cardmarket'
      AND source_record_id=ANY($1::text[])
    ORDER BY created_at DESC`, [productIds]);

  const { artifact: guideArtifact, snapshot } = await fetchCardmarketPokemonPriceGuide();
  const currentByProduct = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const mappingsByIdentity = new Map();
  for (const mapping of mappings) {
    const list = mappingsByIdentity.get(mapping.card_identity_id) || [];
    list.push(mapping);
    mappingsByIdentity.set(mapping.card_identity_id, list);
  }

  const ownersBySource = new Map(owners.map((row) => [
    key(row.source_record_id, row.source_variant_key),
    row.owners || [],
  ]));

  const rejectionsBySource = new Map();
  for (const rejection of rejections) {
    const listKey = key(rejection.source_record_id, rejection.source_variant_key);
    const list = rejectionsBySource.get(listKey) || [];
    list.push(rejection);
    rejectionsBySource.set(listKey, list);
  }

  const classes = {};
  const byVariant = {};
  const rows = [];

  for (const identity of identities) {
    increment(byVariant, identity.variant_code);
    const targetSourceVariant = TARGET_SOURCE_VARIANT[identity.variant_code];
    const targetPriceLane = TARGET_PRICE_LANE[identity.variant_code];
    const allMappings = mappingsByIdentity.get(identity.card_identity_id) || [];
    const targetMappings = allMappings.filter((mapping) => mapping.source_variant_key === targetSourceVariant);

    let classification;
    let targetMapping = null;
    let currentRow = null;
    let currentTargetLanePositive = false;
    let currentBaseLanePositive = false;
    let ownershipConflict = false;
    let sourceOwners = [];
    let relevantRejections = [];
    let historicalTargetLanePositive = false;
    let historicalBaseLanePositive = false;

    if (targetMappings.length === 0) {
      classification = 'mapping_finish_key_missing';
    } else if (targetMappings.length > 1) {
      classification = 'multiple_target_product_mappings';
    } else {
      [targetMapping] = targetMappings;
      const sourceRecordId = String(targetMapping.source_record_id);
      sourceOwners = ownersBySource.get(key(sourceRecordId, targetSourceVariant)) || [];
      ownershipConflict = sourceOwners.some((owner) => owner !== identity.card_identity_id);
      currentRow = currentByProduct.get(sourceRecordId) || null;
      currentTargetLanePositive = Boolean(currentRow && hasMeaningfulCardmarketLane(currentRow, targetPriceLane));
      currentBaseLanePositive = Boolean(currentRow && hasMeaningfulCardmarketLane(currentRow, 'standard'));
      relevantRejections = [
        ...(rejectionsBySource.get(key(sourceRecordId, targetPriceLane)) || []),
        ...(identity.variant_code === 'holo' ? (rejectionsBySource.get(key(sourceRecordId, 'standard')) || []) : []),
      ].sort((a, b) => Number(b.created_at) - Number(a.created_at));

      for (const rejection of relevantRejections) {
        const providerRow = rejectionProviderRow(rejection);
        if (!providerRow) continue;
        if (hasMeaningfulCardmarketLane(providerRow, targetPriceLane)) historicalTargetLanePositive = true;
        if (hasMeaningfulCardmarketLane(providerRow, 'standard')) historicalBaseLanePositive = true;
      }

      if (ownershipConflict) classification = 'conflicting_product_finish_ownership';
      else if (currentTargetLanePositive) classification = 'current_target_lane_priceable';
      else if (identity.variant_code === 'holo' && currentBaseLanePositive) classification = 'holo_base_lane_requires_exact_review';
      else if (historicalTargetLanePositive) classification = 'historical_target_lane_rejected_currently_unavailable';
      else if (historicalBaseLanePositive) classification = 'historical_base_lane_rejected_currently_unavailable_or_exception_needed';
      else classification = 'provider_no_positive_supported_lane';
    }

    increment(classes, classification);
    rows.push({
      cardIdentityId: identity.card_identity_id,
      printingId: identity.printing_id,
      setId: identity.set_id,
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      classification,
      targetSourceVariant,
      targetPriceLane,
      mappings: allMappings.map((mapping) => ({
        id: mapping.id,
        sourceRecordId: String(mapping.source_record_id),
        sourceVariantKey: mapping.source_variant_key,
        sourceVersion: mapping.source_version,
      })),
      targetMapping: targetMapping ? {
        id: targetMapping.id,
        sourceRecordId: String(targetMapping.source_record_id),
        sourceVariantKey: targetMapping.source_variant_key,
      } : null,
      sourceOwners,
      ownershipConflict,
      currentTargetLanePositive,
      currentBaseLanePositive,
      historicalTargetLanePositive,
      historicalBaseLanePositive,
      currentProviderRow: compactPriceRow(currentRow),
      latestRejections: relevantRejections.slice(0, 5).map((rejection) => ({
        sourceRecordId: String(rejection.source_record_id),
        sourceVariantKey: rejection.source_variant_key,
        rejectionCode: rejection.rejection_code,
        rejectionDetail: rejection.rejection_detail,
        sourceSnapshotId: rejection.source_snapshot_id,
        createdAt: Number(rejection.created_at),
        providerRow: compactPriceRow(rejectionProviderRow(rejection)),
      })),
    });
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
      sourceEffectiveAt: snapshot.sourceEffectiveAt,
      currencyCode: snapshot.currencyCode,
    },
    counts: {
      mappedWithoutPositivePrice: identities.length,
      standard: Number(byVariant.standard || 0),
      holo: Number(byVariant.holo || 0),
    },
    classes,
    rows,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = {
      status: 'blocked',
      productionWrites: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-residual-price-audit.json`;
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      status: report.status,
      productionWrites: report.productionWrites,
      source: report.source,
      counts: report.counts,
      classes: report.classes,
      samples: report.rows?.slice(0, 20),
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
