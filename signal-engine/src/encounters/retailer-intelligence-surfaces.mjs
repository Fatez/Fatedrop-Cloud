import crypto from "node:crypto";

import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { reconcileCuratedIncomingIntel } from "./curated-incoming-intel-reconcile.mjs";
import { publishOperatorNotification } from "./operator-local-radar-intake.mjs";

export const RETAILER_INTELLIGENCE_SURFACES = Object.freeze({
  "entertainer-pokemon-drop-hub": Object.freeze({
    surfaceId: "entertainer-pokemon-drop-hub",
    retailerId: "entertainer-uk",
    retailerName: "The Entertainer",
    sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
    sourceType: "official_retailer_page",
    maxProducts: 30,
    maxBranchesPerProduct: 250,
maxNotificationsPerChange: 5,
notificationMode: "observation_only_until_radius_targeted",
  }),
});

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3], ["may", 4], ["june", 5],
  ["july", 6], ["august", 7], ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);

let schemaPromise = null;

function cleanText(value, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueSorted(values, maxItems, maxLength = 180) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, maxLength))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxItems);
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableProduct(product) {
  return {
    title: product.title,
    releaseLabel: product.releaseLabel || null,
    allocationGroup: product.allocationGroup || null,
    purchaseLimit: product.purchaseLimit || null,
    allocationLimited: product.allocationLimited === true,
    branchTargets: (product.branchTargets || []).map((branch) => ({ name: branch.name, storeUrl: branch.storeUrl || null })),
    assetReferenceHints: [...(product.assetReferenceHints || [])],
  };
}

export function normalizeRetailerIntelligenceSnapshot(input = {}, now = Date.now()) {
  const surfaceId = cleanText(input.surfaceId, 120);
  const policy = RETAILER_INTELLIGENCE_SURFACES[surfaceId];
  if (!policy) throw new Error("Retailer intelligence surface is not allowlisted");

  const retailerId = cleanText(input.retailerId, 120);
  if (retailerId !== policy.retailerId) throw new Error("Retailer intelligence retailer identity mismatch");
  const sourceUrl = canonicalUrl(input.sourceUrl);
  if (sourceUrl !== canonicalUrl(policy.sourceUrl)) throw new Error("Retailer intelligence source URL mismatch");

  const observedAtMs = Date.parse(String(input.observedAt || ""));
  const safeObservedAt = Number.isFinite(observedAtMs) ? observedAtMs : now;
  if (Math.abs(safeObservedAt - now) > 24 * 60 * 60 * 1000) throw new Error("Retailer intelligence observedAt is outside the accepted freshness window");

  const products = [];
  const seen = new Set();
  for (const raw of Array.isArray(input.products) ? input.products : []) {
    const title = cleanText(raw?.title, 240);
    if (!title) continue;
    const productKey = normalizeKey(title);
    if (!productKey || seen.has(productKey)) continue;
  const rawTargets = Array.isArray(raw?.branchTargets) ? raw.branchTargets : [];
const targetsByName = new Map();
for (const target of rawTargets) {
  const name = cleanText(target?.name, 180);
  if (!name) continue;
  const storeUrl = canonicalUrl(target?.storeUrl);
  targetsByName.set(normalizeKey(name), { name, storeUrl });
}
for (const name of uniqueSorted(raw?.branches, policy.maxBranchesPerProduct, 180)) {
  const key = normalizeKey(name);
  if (!targetsByName.has(key)) targetsByName.set(key, { name, storeUrl: null });
}
const branchTargets = [...targetsByName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, policy.maxBranchesPerProduct);
const branches = branchTargets.map((target) => target.name);
if (!branches.length) continue;
seen.add(productKey);
products.push({
  productKey,
  title,
  releaseLabel: cleanText(raw?.releaseLabel, 160),
  allocationGroup: cleanText(raw?.allocationGroup, 140),
  purchaseLimit: cleanText(raw?.purchaseLimit, 120),
  allocationLimited: raw?.allocationLimited === true,
  branches,
  branchTargets,
  assetReferenceHints: uniqueSorted(raw?.assetReferenceHints, 10, 80),
});
    if (products.length >= policy.maxProducts) break;
  }

  if (!products.length) throw new Error("Retailer intelligence snapshot has no branch-addressable product allocations");
  products.sort((left, right) => left.productKey.localeCompare(right.productKey));

  const fingerprintPayload = JSON.stringify(products.map(stableProduct));
  const fingerprint = hash(`${surfaceId}|${fingerprintPayload}`);
  return {
    schemaVersion: 1,
    surfaceId,
    retailerId: policy.retailerId,
    retailerName: policy.retailerName,
    sourceUrl: policy.sourceUrl,
    sourceType: policy.sourceType,
    observedAt: Math.floor(safeObservedAt / 1000),
pageTitle: cleanText(input.pageTitle, 240),
campaignTitle: cleanText(input.campaignTitle, 240),
availabilityDisclaimerPresent: input.availabilityDisclaimerPresent === true,
storeSearchSemantics: cleanText(input.storeSearchSemantics, 120),
warnings: uniqueSorted(input.warnings, 30, 160),
publicHttp: input.publicHttp && typeof input.publicHttp === "object" ? {
  status: Number(input.publicHttp.status) || null,
  etag: cleanText(input.publicHttp.etag, 300),
  lastModified: cleanText(input.publicHttp.lastModified, 300),
  bodySha256: cleanText(input.publicHttp.bodySha256, 80),
  body: typeof input.publicHttp.body === "string" ? input.publicHttp.body.slice(0, 750000) : null,
} : null,
fingerprint,
products,
  };
}

export function diffRetailerIntelligenceSnapshots(previousSnapshot, currentSnapshot) {
  const previous = new Map((previousSnapshot?.products || []).map((product) => [product.productKey || normalizeKey(product.title), product]));
  const current = new Map((currentSnapshot?.products || []).map((product) => [product.productKey || normalizeKey(product.title), product]));
  const changes = [];

  for (const [key, product] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push({ product, reasons: ["product_added"], addedBranches: [...product.branches], removedBranches: [] });
      continue;
    }
    const beforeBranches = new Set(before.branches || []);
    const nowBranches = new Set(product.branches || []);
    const addedBranches = [...nowBranches].filter((branch) => !beforeBranches.has(branch)).sort();
    const removedBranches = [...beforeBranches].filter((branch) => !nowBranches.has(branch)).sort();
    const reasons = [];
    if ((before.releaseLabel || null) !== (product.releaseLabel || null)) reasons.push("release_window_changed");
    if ((before.allocationGroup || null) !== (product.allocationGroup || null)) reasons.push("allocation_group_changed");
    if ((before.purchaseLimit || null) !== (product.purchaseLimit || null)) reasons.push("purchase_limit_changed");
    if (before.allocationLimited !== product.allocationLimited) reasons.push("allocation_policy_changed");
    if (addedBranches.length) reasons.push("allocation_expanded");
    if (removedBranches.length) reasons.push("allocation_contracted");
    if (reasons.length) changes.push({ product, reasons, addedBranches, removedBranches });
  }

  for (const [key, product] of previous) {
    if (!current.has(key)) changes.push({ product, reasons: ["product_removed"], addedBranches: [], removedBranches: [...(product.branches || [])] });
  }
  return changes;
}

function releaseDateFromLabel(label, observedAtMs) {
  const value = String(label || "").toLowerCase();
  const match = value.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS.get(match[2].toLowerCase());
  if (!Number.isInteger(day) || month == null) return null;
  const observed = new Date(observedAtMs);
  let year = match[3] ? Number(match[3]) : observed.getUTCFullYear();
  let candidate = Date.UTC(year, month, day, 8, 0, 0);
  if (!match[3] && candidate < observedAtMs - 120 * 24 * 60 * 60 * 1000) {
    year += 1;
    candidate = Date.UTC(year, month, day, 8, 0, 0);
  }
  return candidate;
}

function expectedWindow(product, snapshot) {
  const observedAtMs = snapshot.observedAt * 1000;
  const releaseAt = releaseDateFromLabel(product.releaseLabel, observedAtMs);
  if (releaseAt) {
    return {
      expectedFrom: new Date(releaseAt).toISOString(),
      expectedTo: new Date(releaseAt + (24 * 60 * 60 * 1000) - 1).toISOString(),
      expiresAt: new Date(Math.max(releaseAt + 3 * 24 * 60 * 60 * 1000, observedAtMs + 24 * 60 * 60 * 1000)).toISOString(),
    };
  }
  return {
    expectedFrom: null,
    expectedTo: null,
    expiresAt: new Date(observedAtMs + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function changeSummary(change) {
  if (change.reasons.includes("product_added")) return "new allocation published";
  if (change.reasons.includes("allocation_expanded")) return `allocation expanded by ${change.addedBranches.length} store${change.addedBranches.length === 1 ? "" : "s"}`;
  if (change.reasons.includes("release_window_changed")) return "release timing updated";
  if (change.reasons.includes("purchase_limit_changed")) return "purchase limit updated";
  if (change.reasons.includes("allocation_policy_changed")) return "allocation policy updated";
  if (change.reasons.includes("allocation_contracted")) return `allocation list reduced by ${change.removedBranches.length} store${change.removedBranches.length === 1 ? "" : "s"}`;
  return "allocation page updated";
}

function entryForProduct(snapshot, product) {
  const window = expectedWindow(product, snapshot);
  return {
    id: `retailer-intelligence:${snapshot.surfaceId}:${hash(product.productKey).slice(0, 16)}:${snapshot.fingerprint.slice(0, 16)}`,
    retailerId: snapshot.retailerId,
    kind: "echo",
    rawProductTitle: product.title,
    sourceType: snapshot.sourceType,
    sourceId: `retailer-intelligence:${snapshot.surfaceId}:${snapshot.fingerprint}`,
    sourceUrl: snapshot.sourceUrl,
    sourceLabel: `${snapshot.retailerName} official Pokémon allocation page`,
    observedAt: new Date(snapshot.observedAt * 1000).toISOString(),
    expectedFrom: window.expectedFrom,
    expectedTo: window.expectedTo,
    expectedLabel: product.releaseLabel || "Official retailer allocation published",
    expiresAt: window.expiresAt,
    confidence: 0.78,
    evidenceBasis: "Browser-rendered first-party retailer allocation intelligence. Named branches are expected recipients only; physical stock is not verified.",
    note: product.purchaseLimit
      ? `${product.purchaseLimit}. Incoming stock intelligence only; check the retailer before travelling.`
      : "Incoming stock intelligence only; check the retailer before travelling.",
    targetBranches: product.branches,
  };
}

async function databasePool(store) {
  if (typeof store?.pool !== "function") throw new Error("Retailer intelligence persistence requires the canonical PostgreSQL store");
  return store.pool();
}

export async function ensureRetailerIntelligenceSchema(store) {
  if (typeof store?.ensureRetailerIntelligenceSchema === "function") return store.ensureRetailerIntelligenceSchema();
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = await databasePool(store);
      await pool.query(`
CREATE TABLE IF NOT EXISTS fatedrop_retailer_intelligence_surfaces (
          surface_id TEXT PRIMARY KEY,
          retailer_id TEXT NOT NULL,
          source_url TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          snapshot_json JSONB NOT NULL,
          first_seen_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          last_changed_at BIGINT NOT NULL
  )
`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS fatedrop_retailer_intelligence_snapshot_history (
    surface_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    retailer_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    first_observed_at BIGINT NOT NULL,
    last_observed_at BIGINT NOT NULL,
    snapshot_json JSONB NOT NULL,
    PRIMARY KEY (surface_id, fingerprint)
  )
`);
return true;
    })().catch((error) => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

async function loadSurfaceState(store, surfaceId) {
  if (typeof store?.getRetailerIntelligenceSurfaceState === "function") return store.getRetailerIntelligenceSurfaceState(surfaceId);
  await ensureRetailerIntelligenceSchema(store);
  const pool = await databasePool(store);
  const { rows } = await pool.query(`
    SELECT surface_id,retailer_id,source_url,fingerprint,snapshot_json,first_seen_at,last_seen_at,last_changed_at
    FROM fatedrop_retailer_intelligence_surfaces WHERE surface_id=$1
  `, [surfaceId]);
  const row = rows[0];
  return row ? {
    surfaceId: row.surface_id,
    retailerId: row.retailer_id,
    sourceUrl: row.source_url,
    fingerprint: row.fingerprint,
    snapshot: row.snapshot_json,
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    lastChangedAt: Number(row.last_changed_at),
  } : null;
}

async function saveSurfaceState(store, snapshot, previous, changed) {
  if (typeof store?.saveRetailerIntelligenceSurfaceState === "function") {
    return store.saveRetailerIntelligenceSurfaceState({ snapshot, previous, changed });
  }
  await ensureRetailerIntelligenceSchema(store);
  const pool = await databasePool(store);
  const firstSeenAt = previous?.firstSeenAt || snapshot.observedAt;
  const lastChangedAt = changed ? snapshot.observedAt : previous?.lastChangedAt || snapshot.observedAt;
await pool.query(`
  INSERT INTO fatedrop_retailer_intelligence_snapshot_history (surface_id,fingerprint,retailer_id,source_url,first_observed_at,last_observed_at,snapshot_json)
  VALUES ($1,$2,$3,$4,$5,$5,$6::jsonb)
  ON CONFLICT (surface_id,fingerprint) DO UPDATE SET last_observed_at=GREATEST(fatedrop_retailer_intelligence_snapshot_history.last_observed_at,EXCLUDED.last_observed_at)
`, [snapshot.surfaceId, snapshot.fingerprint, snapshot.retailerId, snapshot.sourceUrl, snapshot.observedAt, JSON.stringify(snapshot)]);
await pool.query(`
  INSERT INTO fatedrop_retailer_intelligence_surfaces (
      surface_id,retailer_id,source_url,fingerprint,snapshot_json,first_seen_at,last_seen_at,last_changed_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
    ON CONFLICT (surface_id) DO UPDATE SET
      retailer_id=EXCLUDED.retailer_id,
      source_url=EXCLUDED.source_url,
      fingerprint=EXCLUDED.fingerprint,
      snapshot_json=EXCLUDED.snapshot_json,
      last_seen_at=EXCLUDED.last_seen_at,
      last_changed_at=CASE
        WHEN fatedrop_retailer_intelligence_surfaces.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN EXCLUDED.last_changed_at
        ELSE fatedrop_retailer_intelligence_surfaces.last_changed_at
      END
  `, [snapshot.surfaceId, snapshot.retailerId, snapshot.sourceUrl, snapshot.fingerprint, JSON.stringify(snapshot), firstSeenAt, snapshot.observedAt, lastChangedAt]);
  return { saved: true };
}

function shouldInterrupt(change) {
  return change.reasons.some((reason) => [
    "product_added",
    "allocation_expanded",
    "release_window_changed",
    "purchase_limit_changed",
    "allocation_policy_changed",
  ].includes(reason));
}

function notificationFor(snapshot, change, reconciliation) {
  const product = change.product;
  const facets = deriveAlertFacets({ title: product.title, retailerCountryCode: "GB" });
  const branchCount = reconciliation.matchedBranches;
  const release = product.releaseLabel ? ` · ${product.releaseLabel}` : "";
  return {
    eventId: `retailer-intelligence:${snapshot.surfaceId}:${hash(product.productKey).slice(0, 12)}:${snapshot.fingerprint.slice(0, 16)}`,
    testOnly: false,
    stage: "ECHO",
    presentationType: "big_fate_signal",
    physicalEvidenceState: "expected",
    availabilityScope: "physical_branch",
    availabilityVerified: false,
    title: "BIG FATE SIGNAL · ECHO",
    body: `${product.title} · ${changeSummary(change)} · ${branchCount} ${snapshot.retailerName} store${branchCount === 1 ? "" : "s"}${release}. Expected allocation only — branch stock is not confirmed.`,
    retailerId: snapshot.retailerId,
    retailerName: snapshot.retailerName,
    productTitle: product.title,
    expectedFrom: entryForProduct(snapshot, product).expectedFrom,
    expectedTo: entryForProduct(snapshot, product).expectedTo,
    expectedLabel: product.releaseLabel || null,
    branchCount,
    intelligenceSurfaceId: snapshot.surfaceId,
    retailerUrl: snapshot.sourceUrl,
    ctaLabel: "CHECK YOUR LOCAL ENTERTAINER",
    evidenceObservedAt: new Date(snapshot.observedAt * 1000).toISOString(),
    changeReasons: change.reasons,
    languageGroup: facets.languageGroup,
    setKey: facets.setKey,
  };
}

export async function reconcileRetailerIntelligenceSurfaceSnapshot({
  store,
  snapshot: rawSnapshot,
  reconcile = reconcileCuratedIncomingIntel,
  publish = publishOperatorNotification,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Retailer intelligence reconciliation requires a store");
  const snapshot = normalizeRetailerIntelligenceSnapshot(rawSnapshot, now);
  const policy = RETAILER_INTELLIGENCE_SURFACES[snapshot.surfaceId];
  const previous = await loadSurfaceState(store, snapshot.surfaceId);

  if (previous?.fingerprint === snapshot.fingerprint) {
    await saveSurfaceState(store, snapshot, previous, false);
    return {
      status: "unchanged",
      surfaceId: snapshot.surfaceId,
      fingerprint: snapshot.fingerprint,
      products: snapshot.products.length,
      notificationsPublished: 0,
      truthRule: "Unchanged retailer intelligence is silent and can never create Manifested.",
    };
  }

  const baseline = !previous;
  const changes = baseline
    ? snapshot.products.map((product) => ({ product, reasons: ["baseline"], addedBranches: [...product.branches], removedBranches: [] }))
    : diffRetailerIntelligenceSnapshots(previous.snapshot, snapshot);
  const actionable = changes.filter((change) => !change.reasons.includes("product_removed"));
  const reconciliations = [];
  const notifications = [];

  for (const change of actionable) {
    const entry = entryForProduct(snapshot, change.product);
    const result = await reconcile({ store, entries: [entry], now });
    reconciliations.push({ productTitle: change.product.title, reasons: change.reasons, ...result });
    if (baseline || !shouldInterrupt(change)) continue;
    if (result.unmatchedTargets?.length || result.matchedBranches !== change.product.branches.length) continue;
if (notifications.length >= policy.maxNotificationsPerChange) continue;
const notification = notificationFor(snapshot, change, result);
if (policy.notificationMode !== "radius_targeted") {
notifications.push({ ...notification, published: false, held: true, deliverable: false, reason: "radius_targeting_required" });
  continue;
}
const push = await publish(notification);
notifications.push({ eventId: notification.eventId, productTitle: change.product.title, ...push });
  }

  await saveSurfaceState(store, snapshot, previous, true);
  const unmatchedTargets = reconciliations.reduce((sum, result) => sum + (result.unmatchedTargets?.length || 0), 0);
  const matchedBranches = reconciliations.reduce((sum, result) => sum + (result.matchedBranches || 0), 0);
  const savedObservations = reconciliations.reduce((sum, result) => sum + (result.saved || 0), 0);
  return {
    status: baseline ? "baseline" : "changed",
    surfaceId: snapshot.surfaceId,
    fingerprint: snapshot.fingerprint,
    products: snapshot.products.length,
    changes: changes.map((change) => ({
      productTitle: change.product.title,
      reasons: change.reasons,
      addedBranches: change.addedBranches.length,
      removedBranches: change.removedBranches.length,
    })),
    matchedBranches,
    unmatchedTargets,
    savedObservations,
    notificationsAttempted: notifications.length,
notificationsPublished: notifications.filter((item) => item.published).length,
notificationsHeld: notifications.filter((item) => item.held).length,
    notificationResults: notifications,
    baselineSilent: baseline,
truthRule: "Retailer intelligence surfaces create Echo · Expected physical evidence only. Verified exact-branch physical stock remains Echo · In-store confirmed; physical evidence never creates Manifested or ordinary Vanished.",
  };
}
