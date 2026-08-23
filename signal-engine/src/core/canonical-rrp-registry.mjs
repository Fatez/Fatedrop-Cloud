import { compareProductIdentity, describeProductIdentity } from "./product-identity.mjs";

function authoritative(product = {}) {
  return Number.isFinite(product.officialRrpPence)
    && product.officialRrpPence > 0
    && typeof product.rrpSource === "string"
    && product.rrpSource.trim().length > 0;
}

function bucketFor(input = {}) {
  const descriptor = describeProductIdentity(input);
  if (!descriptor.productType || !descriptor.coreSignature) return null;
  return `${descriptor.productType}\u241f${descriptor.coreSignature}`;
}

function candidateInput(product = {}) {
  return {
    title: product.title,
    productType: product.productType,
    tcg: product.tcg || "pokemon",
    language: product.language,
    region: product.region,
    edition: product.edition,
    packCount: product.packCount,
    caseQuantity: product.caseQuantity,
    unitKind: product.unitKind,
    formatVariant: product.formatVariant,
    presentation: product.presentation,
    identifiers: product.identifiers,
  };
}

export function buildCanonicalRrpRegistry(products = []) {
  const buckets = new Map();
  let authoritativeProducts = 0;

  for (const product of products || []) {
    if (!authoritative(product)) continue;
    const key = bucketFor(candidateInput(product));
    if (!key) continue;
    const rows = buckets.get(key) || [];
    rows.push(product);
    buckets.set(key, rows);
    authoritativeProducts += 1;
  }

  return { buckets, authoritativeProducts };
}

export function resolveCanonicalRrp(input, registry) {
  if (!registry?.buckets) return { resolved: false, reason: "registry_unavailable" };
  const key = bucketFor(input);
  if (!key) return { resolved: false, reason: "identity_bucket_unavailable" };
  const candidates = registry.buckets.get(key) || [];
  if (!candidates.length) return { resolved: false, reason: "no_authoritative_candidate" };

  const matches = candidates.filter((candidate) => compareProductIdentity(
    input,
    candidateInput(candidate),
  ).decision === "match");

  if (!matches.length) return { resolved: false, reason: "no_exact_identity_match" };

  const prices = [...new Set(matches.map((candidate) => Math.round(candidate.officialRrpPence)))];
  if (prices.length !== 1) {
    return {
      resolved: false,
      reason: "conflicting_verified_rrp",
      candidateCount: matches.length,
      prices,
    };
  }

  const sources = [...new Set(matches.map((candidate) => String(candidate.rrpSource).trim()).filter(Boolean))];
  const observed = matches
    .map((candidate) => Number(candidate.rrpObservedAt))
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    resolved: true,
    officialRrpPence: prices[0],
    rrpSource: sources.length === 1 ? sources[0] : `verified:${sources.sort().join("+")}`,
    rrpObservedAt: observed.length ? Math.max(...observed) : null,
    candidateCount: matches.length,
    matchedProductIds: matches.map((candidate) => candidate.id).filter(Boolean),
  };
}
