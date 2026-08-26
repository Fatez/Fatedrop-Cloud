import { ingestRetailerDiscoveryObservations } from "./discovery-intake.mjs";

export const PRODUCT_DISCOVERY_WATCH_SOURCE = "product_discovery_watch";
const DEFAULT_LIMIT = 25;
const MAX_ATTEMPTS = 3;
const LOCK_NAME = "fatedrop:product-discovery-watch-reconcile";

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strictBoolean(value) {
  return value === true;
}

function evidenceObject(row) {
  return row?.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
    ? row.evidence
    : {};
}

function attemptCount(row) {
  const value = Number(evidenceObject(row)?.canonical_pipeline?.attempts || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function discoveryWatchRowToObservation(row) {
  const evidence = evidenceObject(row);
  const title = String(evidence.title || "").trim();
  if (!title) throw new Error("Drop Watch evidence is missing product title");

  const sourceUrl = String(row?.source_url || evidence.canonicalUrl || evidence.url || "").trim();
  if (!sourceUrl) throw new Error("Drop Watch evidence is missing source URL");

  return {
    discoveryObservation: true,
    title,
    canonicalUrl: sourceUrl,
    retailerSku: evidence.retailerSku || evidence.sku || null,
    canonicalProductId: evidence.canonicalProductId || null,
    pageExists: evidence.pageExists === false ? false : strictBoolean(evidence.pageExists),
    officialPageVerified: strictBoolean(evidence.officialPageVerified),
    discoveredAt: finiteNumber(evidence.discoveredAt) ?? finiteNumber(row?.observed_at) ?? undefined,
    evidenceSource: String(evidence.evidenceSource || "pokemon_uk_drop_watch"),
    changeType: String(evidence.changeType || "product_page_observed"),
    confidence: finiteNumber(evidence.confidence) ?? 0.9,
    preorder: strictBoolean(evidence.preorder),
    preorderText: strictBoolean(evidence.preorderText),
    preorderLabel: strictBoolean(evidence.preorderLabel),
    availabilityText: evidence.availabilityText == null ? undefined : String(evidence.availabilityText),
    addToCartEnabled: strictBoolean(evidence.addToCartEnabled),
    preorderPurchaseEnabled: strictBoolean(evidence.preorderPurchaseEnabled),
    checkoutVerified: strictBoolean(evidence.checkoutVerified),
    availabilityApiVerified: strictBoolean(evidence.availabilityApiVerified),
    orderable: strictBoolean(evidence.orderable),
    stockStatus: evidence.stockStatus == null ? undefined : String(evidence.stockStatus),
    pricePence: finiteNumber(evidence.pricePence),
    postagePence: finiteNumber(evidence.postagePence),
    officialRrpPence: finiteNumber(evidence.officialRrpPence),
    stockQuantity: finiteNumber(evidence.stockQuantity),
    releaseDate: evidence.releaseDate == null ? undefined : String(evidence.releaseDate),
    imageUrl: evidence.imageUrl == null ? undefined : String(evidence.imageUrl),
    productType: evidence.productType == null ? undefined : String(evidence.productType),
    canonicalKey: evidence.canonicalKey == null ? undefined : String(evidence.canonicalKey),
    language: evidence.language == null ? undefined : String(evidence.language),
    region: evidence.region == null ? undefined : String(evidence.region),
    edition: evidence.edition == null ? undefined : String(evidence.edition),
    packCount: finiteNumber(evidence.packCount),
    rawObservation: evidence.rawObservation == null ? undefined : String(evidence.rawObservation),
  };
}

async function updatePipeline(client, evidenceId, pipeline) {
  await client.query(
    `UPDATE fatedrop_retailer_discovery_evidence
       SET evidence = jsonb_set(COALESCE(evidence, '{}'::jsonb), '{canonical_pipeline}', $2::jsonb, true)
     WHERE evidence_id = $1`,
    [evidenceId, JSON.stringify(pipeline)],
  );
}

export async function reconcileProductDiscoveryWatch({
  store,
  retailers = [],
  ingestFn = ingestRetailerDiscoveryObservations,
  now = Math.floor(Date.now() / 1000),
  limit = DEFAULT_LIMIT,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { enabled: false, reason: "persistent_store_required", examined: 0, processed: 0, failed: 0, signalsCreated: 0 };
  }

  const pool = await store.pool();
  const client = await pool.connect();
  let acquired = false;
  const summary = { enabled: true, examined: 0, processed: 0, failed: 0, retried: 0, signalsCreated: 0, deduplicatedSignals: 0, signalIds: [] };

  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [LOCK_NAME]);
    acquired = Boolean(lock.rows?.[0]?.acquired);
    if (!acquired) return { ...summary, skipped: true, reason: "reconcile_in_progress" };

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT));
    const { rows } = await client.query(
      `SELECT evidence_id, retailer_id, source_type, source_url, observed_at, evidence
         FROM fatedrop_retailer_discovery_evidence
        WHERE source_type = $1
          AND COALESCE(evidence->'canonical_pipeline'->>'status', 'pending') IN ('pending', 'retry')
        ORDER BY observed_at ASC
        LIMIT $2`,
      [PRODUCT_DISCOVERY_WATCH_SOURCE, safeLimit],
    );

    summary.examined = rows.length;
    const retailerById = new Map(retailers.map((retailer) => [retailer.id, retailer]));

    for (const row of rows) {
      const attempts = attemptCount(row) + 1;
      const retailer = retailerById.get(row.retailer_id);
      if (!retailer) {
        summary.failed += 1;
        await updatePipeline(client, row.evidence_id, {
          status: "failed",
          attempts,
          processedAt: now,
          reason: "unknown_or_disabled_retailer",
        });
        continue;
      }

      try {
        const observation = discoveryWatchRowToObservation(row);
        const result = await ingestFn({
          retailer,
          store,
          observations: [observation],
          receivedAt: now,
          dispatchNotifications: true,
        });
        const signals = Array.isArray(result?.signals) ? result.signals : [];
        const signalIds = signals.map((signal) => signal.id).filter(Boolean);
        summary.processed += 1;
        summary.signalsCreated += Number(result?.signalsCreated || 0);
        summary.deduplicatedSignals += Number(result?.deduplicatedSignals || 0);
        summary.signalIds.push(...signalIds);
        await updatePipeline(client, row.evidence_id, {
          status: "processed",
          attempts,
          processedAt: now,
          signalsCreated: Number(result?.signalsCreated || 0),
          deduplicatedSignals: Number(result?.deduplicatedSignals || 0),
          signalIds,
          signalStates: signals.map((signal) => signal.state).filter(Boolean),
        });
      } catch (error) {
        const terminal = attempts >= MAX_ATTEMPTS;
        summary.failed += terminal ? 1 : 0;
        summary.retried += terminal ? 0 : 1;
        await updatePipeline(client, row.evidence_id, {
          status: terminal ? "failed" : "retry",
          attempts,
          lastAttemptAt: now,
          reason: String(error?.message || error).slice(0, 1000),
        });
      }
    }

    summary.signalIds = [...new Set(summary.signalIds)];
    return summary;
  } finally {
    if (acquired) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]); } catch {}
    }
    client.release();
  }
}
