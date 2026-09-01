import { ADAPTER_TYPES, RETAILER_STATES, VERIFICATION_STATES } from "./registry.mjs";
import { staticRetailerToRegistryCandidate } from "./static-registry-sync.mjs";

const PROMOTABLE_STATES = new Set([
  RETAILER_STATES.CANDIDATE,
  RETAILER_STATES.QUALIFYING,
  RETAILER_STATES.READY,
]);

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function assertApprovedMonitorConfig(retailer) {
  if (!retailer?.id || retailer.enabled === false) throw new Error("Approved retailer promotion requires an enabled retailer with an id");
  if (![ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    throw new Error(`Approved retailer ${retailer.id} must use a structured Shopify/WooCommerce adapter`);
  }
  if (!retailer?.catalogue?.feedUrl || retailer.catalogue.feedApproved !== true) {
    throw new Error(`Approved retailer ${retailer.id} requires an explicitly approved structured feed`);
  }
  const tcgs = Array.isArray(retailer.tcgs) && retailer.tcgs.length ? retailer.tcgs : [retailer.tcg].filter(Boolean);
  if (tcgs.length !== 1 || tcgs[0] !== "pokemon") {
    throw new Error(`Approved retailer ${retailer.id} wave 1 must monitor exactly Pokemon`);
  }
}

export async function ensureApprovedRetailersMonitored({ registry, retailers = [] } = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.upsert !== "function") {
    throw new TypeError("Canonical retailer registry is required");
  }

  const existing = await registry.list({ limit: 5000 });
  const byId = new Map((existing || []).filter((row) => row?.id).map((row) => [String(row.id), row]));
  const promoted = [];
  const alreadyMonitored = [];
  const blocked = [];

  for (const retailer of retailers || []) {
    assertApprovedMonitorConfig(retailer);
    const desired = staticRetailerToRegistryCandidate(retailer);
    const current = byId.get(desired.id) || null;

    if (!current) {
      const saved = await registry.upsert(desired);
      byId.set(saved.id, saved);
      promoted.push(saved.id);
      continue;
    }
    if (current.state === RETAILER_STATES.MONITORED) {
      alreadyMonitored.push(current.id);
      continue;
    }
    if ([RETAILER_STATES.PAUSED, RETAILER_STATES.REJECTED].includes(current.state)
      || current.verification === VERIFICATION_STATES.SUSPENDED) {
      blocked.push({ id: current.id, state: current.state, verification: current.verification });
      continue;
    }
    if (!PROMOTABLE_STATES.has(current.state)) {
      blocked.push({ id: current.id, state: current.state, verification: current.verification });
      continue;
    }

    const currentHostname = current.hostname || hostname(current.websiteUrl);
    const desiredHostname = desired.hostname || hostname(desired.websiteUrl);
    if (!currentHostname || !desiredHostname || currentHostname !== desiredHostname) {
      throw new Error(`Approved retailer ${desired.id} hostname conflicts with canonical registry identity`);
    }

    const saved = await registry.upsert({
      ...desired,
      // Promotion changes monitoring readiness only. Existing verification truth is preserved.
      verification: current.verification,
      state: RETAILER_STATES.MONITORED,
      discovery: {
        source: current.discovery?.source || desired.discovery.source,
        discoveredAt: current.discovery?.discoveredAt || desired.discovery.discoveredAt,
        evidence: [
          ...(Array.isArray(current.discovery?.evidence) ? current.discovery.evidence : []),
          {
            type: "approved_monitor_rollout",
            source: "retailer-wave-1-2026-09-01",
            note: "Structured stock source qualified; baseline remains silent and stock lifecycle truth remains unchanged.",
          },
        ],
      },
    });
    byId.set(saved.id, saved);
    promoted.push(saved.id);
  }

  return {
    promoted,
    promotedCount: promoted.length,
    alreadyMonitored,
    alreadyMonitoredCount: alreadyMonitored.length,
    blocked,
    blockedCount: blocked.length,
  };
}
