import { createHash } from "node:crypto";
import { ingestRetailerDiscoveryObservations } from "./discovery-intake.mjs";

export const PRODUCT_DISCOVERY_WATCH_SOURCE = "product_discovery_watch";
export const GITHUB_DISCOVERY_TITLE_PREFIX = "[FATEDROP DISCOVERY WATCH] ";
const DEFAULT_LIMIT = 25;
const MAX_ATTEMPTS = 3;
const LOCK_NAME = "fatedrop:product-discovery-watch-reconcile";
const GITHUB_ISSUES_URL = "https://api.github.com/repos/Fatez/Fatedrop-Cloud/issues?state=all&per_page=100&sort=created&direction=desc";
const GITHUB_POLL_INTERVAL_SECONDS = 5 * 60;
let lastGithubPollAt = 0;

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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function epoch(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function hasForbiddenLifecycleKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenLifecycleKey);
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = String(key).trim().toLowerCase();
    if (normalized === "state" || normalized === "lifecycle") return true;
    if (hasForbiddenLifecycleKey(nested)) return true;
  }
  return false;
}

function canonicalPokemonCenterUkUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() !== "www.pokemoncenter.com") return null;
    if (!url.pathname.toLowerCase().startsWith("/en-gb/product/")) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function cleanOptionalString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function githubObservationEvidence(raw, { issueNumber, issueUrl, observedAt }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Discovery issue observation must be an object");
  if (raw.discoveryObservation !== true) throw new Error("Discovery issue observation is not marked as evidence");
  const canonicalUrl = canonicalPokemonCenterUkUrl(raw.canonicalUrl || raw.url || raw.productUrl);
  if (!canonicalUrl) throw new Error("Discovery issue does not contain a canonical Pokémon Center UK product URL");
  const title = String(raw.title || "").trim();
  if (!title) throw new Error("Discovery issue is missing product title");

  const evidence = {
    title,
    canonicalUrl,
    pageExists: raw.pageExists === true,
    officialPageVerified: raw.officialPageVerified === true,
    discoveredAt: observedAt,
    evidenceSource: "pokemon_uk_drop_watch",
    changeType: cleanOptionalString(raw.changeType) || "product_page_observed",
    confidence: finiteNumber(raw.confidence) ?? 0.9,
    preorder: strictBoolean(raw.preorder),
    preorderText: strictBoolean(raw.preorderText),
    preorderLabel: strictBoolean(raw.preorderLabel),
    addToCartEnabled: strictBoolean(raw.addToCartEnabled),
    preorderPurchaseEnabled: strictBoolean(raw.preorderPurchaseEnabled),
    checkoutVerified: strictBoolean(raw.checkoutVerified),
    availabilityApiVerified: strictBoolean(raw.availabilityApiVerified),
    orderable: strictBoolean(raw.orderable),
    transport: {
      type: "github_issue",
      issueNumber,
      issueUrl,
    },
  };

  for (const key of [
    "retailerSku", "canonicalProductId", "availabilityText", "stockStatus", "releaseDate",
    "imageUrl", "productType", "canonicalKey", "language", "region", "edition", "rawObservation",
  ]) {
    const value = cleanOptionalString(raw[key]);
    if (value !== undefined) evidence[key] = value;
  }
  for (const key of ["pricePence", "postagePence", "officialRrpPence", "stockQuantity", "packCount"]) {
    const value = finiteNumber(raw[key]);
    if (value !== null) evidence[key] = value;
  }

  const material = { ...evidence };
  delete material.transport;
  delete material.discoveredAt;
  evidence.fingerprint = sha256(stableJson(material));
  evidence.canonical_pipeline = { status: "pending", attempts: 0 };
  return { sourceUrl: canonicalUrl, evidence };
}

export function githubDiscoveryIssueToRows(issue) {
  if (!issue || typeof issue !== "object" || issue.pull_request) return [];
  const title = String(issue.title || "");
  if (!title.startsWith(GITHUB_DISCOVERY_TITLE_PREFIX)) return [];
  const observedAt = epoch(issue.created_at);
  if (!observedAt) throw new Error("Discovery issue is missing a valid creation time");
  let body;
  try {
    body = JSON.parse(String(issue.body || ""));
  } catch {
    throw new Error("Discovery issue body is not pure JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Discovery issue body must be a JSON object");
  if (hasForbiddenLifecycleKey(body)) throw new Error("Discovery issue attempted to declare lifecycle state");
  if (body.retailerId !== "pokemon-center-uk") throw new Error("Discovery issue retailer is not Pokémon Center UK");
  if (!Array.isArray(body.observations) || body.observations.length === 0 || body.observations.length > 20) {
    throw new Error("Discovery issue must contain between 1 and 20 observations");
  }

  const issueNumber = Number(issue.number);
  const issueUrl = String(issue.html_url || "").trim() || null;
  return body.observations.map((raw) => {
    const normalized = githubObservationEvidence(raw, { issueNumber, issueUrl, observedAt });
    return {
      evidenceId: `watch_${sha256(`pokemon-center-uk|${normalized.sourceUrl}`).slice(0, 32)}`,
      retailerId: "pokemon-center-uk",
      sourceType: PRODUCT_DISCOVERY_WATCH_SOURCE,
      sourceUrl: normalized.sourceUrl,
      observedAt,
      evidence: normalized.evidence,
    };
  });
}

async function upsertGithubEvidence(client, row) {
  const { rows } = await client.query(
    `INSERT INTO fatedrop_retailer_discovery_evidence
      (evidence_id, retailer_id, source_type, source_url, observed_at, evidence)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (retailer_id, source_type, source_url) DO UPDATE SET
       observed_at = EXCLUDED.observed_at,
       evidence = EXCLUDED.evidence
     WHERE EXCLUDED.observed_at >= fatedrop_retailer_discovery_evidence.observed_at
       AND COALESCE(fatedrop_retailer_discovery_evidence.evidence->>'fingerprint', '')
           IS DISTINCT FROM COALESCE(EXCLUDED.evidence->>'fingerprint', '')
     RETURNING evidence_id`,
    [row.evidenceId, row.retailerId, row.sourceType, row.sourceUrl, row.observedAt, JSON.stringify(row.evidence)],
  );
  return rows.length > 0;
}

export async function importGithubDiscoveryIssues(client, {
  now = Math.floor(Date.now() / 1000),
  fetchFn = globalThis.fetch,
  enabled = true,
  force = false,
} = {}) {
  const summary = { enabled, polled: false, examined: 0, imported: 0, unchanged: 0, rejected: 0, error: null };
  if (!enabled || typeof fetchFn !== "function") return summary;
  if (!force && lastGithubPollAt > 0 && now - lastGithubPollAt < GITHUB_POLL_INTERVAL_SECONDS) return summary;

  try {
    const response = await fetchFn(GITHUB_ISSUES_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "FateDrop-Cloud/1.0 discovery-watch",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response?.ok) throw new Error(`GitHub discovery issue poll returned HTTP ${response?.status || "unknown"}`);
    const issues = await response.json();
    if (!Array.isArray(issues)) throw new Error("GitHub discovery issue poll returned an invalid payload");
    summary.polled = true;
    lastGithubPollAt = now;

    const relevant = issues
      .filter((issue) => !issue?.pull_request && String(issue?.title || "").startsWith(GITHUB_DISCOVERY_TITLE_PREFIX))
      .sort((left, right) => Number(epoch(left?.created_at) || 0) - Number(epoch(right?.created_at) || 0));
    summary.examined = relevant.length;

    for (const issue of relevant) {
      try {
        const rows = githubDiscoveryIssueToRows(issue);
        for (const row of rows) {
          const changed = await upsertGithubEvidence(client, row);
          if (changed) summary.imported += 1;
          else summary.unchanged += 1;
        }
      } catch (error) {
        summary.rejected += 1;
      }
    }
    return summary;
  } catch (error) {
    summary.error = String(error?.message || error).slice(0, 1000);
    return summary;
  }
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
  githubFetchFn = globalThis.fetch,
  githubEnabled = String(process.env.RAILWAY_ENVIRONMENT_NAME || "").trim().toLowerCase() === "production",
  forceGithubPoll = false,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { enabled: false, reason: "persistent_store_required", examined: 0, processed: 0, failed: 0, signalsCreated: 0 };
  }

  const pool = await store.pool();
  const client = await pool.connect();
  let acquired = false;
  const summary = {
    enabled: true,
    examined: 0,
    processed: 0,
    failed: 0,
    retried: 0,
    signalsCreated: 0,
    deduplicatedSignals: 0,
    signalIds: [],
    github: { enabled: githubEnabled, polled: false, examined: 0, imported: 0, unchanged: 0, rejected: 0, error: null },
  };

  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [LOCK_NAME]);
    acquired = Boolean(lock.rows?.[0]?.acquired);
    if (!acquired) return { ...summary, skipped: true, reason: "reconcile_in_progress" };

    summary.github = await importGithubDiscoveryIssues(client, {
      now,
      fetchFn: githubFetchFn,
      enabled: githubEnabled,
      force: forceGithubPoll,
    });
    if (summary.github.error) summary.retried += 1;
    if (summary.github.rejected > 0) summary.failed += summary.github.rejected;

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
