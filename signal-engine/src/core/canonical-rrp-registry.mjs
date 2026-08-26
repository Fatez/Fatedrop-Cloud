import { compareProductIdentity, describeProductIdentity } from "./product-identity.mjs";

function authoritative(product = {}) {
  return Number.isFinite(product.officialRrpPence)
    && product.officialRrpPence > 0
    && typeof product.rrpSource === "string"
    && product.rrpSource.trim().length > 0;
}

function normalizeRrpAliasInput(input = {}) {
  const source = typeof input === "string" ? { title: input } : (input || {});
  const title = String(source.title || "");
  const tcg = String(source.tcg || "pokemon").trim().toLowerCase();

  // Keep retailer naming aliases local to RRP resolution. This preserves the raw
  // catalogue title/evidence while allowing verified official identities to be
  // reused safely across common retailer wording differences.
  let normalizedTitle = title;
  if (tcg === "pokemon") {
    normalizedTitle = normalizedTitle
      .replace(/\bSWSH\b/gi, " Sword & Shield ")
      .replace(/\bBooster\s+Display\s+Box\b/gi, " Booster Box ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Retailers frequently publish the same Pokemon expansion using a set code or
  // series prefix while the official catalogue uses the long expansion name.
  // Keep these aliases local to RRP identity resolution so catalogue titles and
  // evidence remain untouched. Add only verified aliases; never fuzzy-match them.
  if (tcg === "pokemon" && /\bchaos[\s-]+rising\b/i.test(normalizedTitle)) {
    normalizedTitle = normalizedTitle
      .replace(/\bME\s*0?4\b/gi, " ")
      .replace(/\bMega\s+Evolution(?:\s+4)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return normalizedTitle === title ? source : { ...source, title: normalizedTitle };
}

function bucketFor(input = {}) {
  const descriptor = describeProductIdentity(normalizeRrpAliasInput(input));
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

function uniquePositivePackCounts(candidates = []) {
  return [...new Set(candidates
    .map((candidate) => describeProductIdentity(normalizeRrpAliasInput(candidateInput(candidate))).packCount)
    .filter((value) => Number.isFinite(value) && value > 1))];
}

function omittedStandardBoosterBoxMatches(input, candidates = []) {
  const normalizedInput = normalizeRrpAliasInput(input);
  const descriptor = describeProductIdentity(normalizedInput);
  if (descriptor.productType !== "booster_box"
    || descriptor.packCount != null
    || descriptor.formatVariant !== "standard"
    || descriptor.unitKind !== "unit"
    || descriptor.presentation !== "standard") {
    return [];
  }

  const relaxed = candidates.filter((candidate) => {
    const normalizedCandidate = normalizeRrpAliasInput(candidateInput(candidate));
    const candidateDescriptor = describeProductIdentity(normalizedCandidate);
    if (!Number.isFinite(candidateDescriptor.packCount) || candidateDescriptor.packCount <= 1) return false;
    return compareProductIdentity(
      { ...normalizedInput, packCount: candidateDescriptor.packCount },
      normalizedCandidate,
    ).decision === "match";
  });

  // Missing quantity can only be inherited when the canonical registry itself is
  // unambiguous about the standard box configuration. Multiple pack counts remain
  // unresolved even if one happens to be more common.
  return uniquePositivePackCounts(relaxed).length === 1 ? relaxed : [];
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
  const normalizedInput = normalizeRrpAliasInput(input);
  const key = bucketFor(normalizedInput);
  if (!key) return { resolved: false, reason: "identity_bucket_unavailable" };
  const candidates = registry.buckets.get(key) || [];
  if (!candidates.length) return { resolved: false, reason: "no_authoritative_candidate" };

  let matches = candidates.filter((candidate) => compareProductIdentity(
    normalizedInput,
    normalizeRrpAliasInput(candidateInput(candidate)),
  ).decision === "match");

  if (!matches.length) matches = omittedStandardBoosterBoxMatches(normalizedInput, candidates);
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
