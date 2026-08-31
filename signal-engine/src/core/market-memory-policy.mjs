export const MARKET_MEMORY_VERSION = 1;

export const MARKET_GROUPS = Object.freeze([
  { key: "english", label: "English / International" },
  { key: "japanese", label: "Japan" },
  { key: "korean", label: "Korea" },
  { key: "simplified_chinese", label: "Mainland China" },
  { key: "traditional_chinese", label: "Taiwan / Hong Kong" },
  { key: "other", label: "Other verified markets" },
  { key: "unknown", label: "Unknown market" },
]);

const MARKET_CODES = new Set(["GB", "US", "CA", "AU", "NZ", "IE", "JP", "KR", "CN", "TW", "HK"]);

function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMarketCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return MARKET_CODES.has(code) ? code : null;
}

export function marketGroupForCode(value) {
  const code = normalizeMarketCode(value);
  if (["GB", "US", "CA", "AU", "NZ", "IE"].includes(code)) return "english";
  if (code === "JP") return "japanese";
  if (code === "KR") return "korean";
  if (code === "CN") return "simplified_chinese";
  if (["TW", "HK"].includes(code)) return "traditional_chinese";
  return code ? "other" : "unknown";
}

export function explicitListingMarketClaims({ title = "", region = null } = {}) {
  const claims = [];
  const text = ` ${fold(title)} `;
  const explicitRegion = normalizeMarketCode(region);
  if (explicitRegion) claims.push({ marketCode: explicitRegion, source: "structured_region", authority: "candidate" });

  let titleMarket = null;
  if (/\b(?:japanese|japan|jpn|jp)\b/.test(text)) titleMarket = "JP";
  else if (/\b(?:korean|korea|kr)\b/.test(text)) titleMarket = "KR";
  else if (/\b(?:simplified chinese|chinese simplified|mainland china|chs|cn)\b/.test(text)) titleMarket = "CN";
  else if (/\b(?:traditional chinese|cht)\b/.test(text) && /\b(?:taiwan|tw)\b/.test(text)) titleMarket = "TW";
  else if (/\b(?:traditional chinese|cht)\b/.test(text) && /\b(?:hong kong|hk)\b/.test(text)) titleMarket = "HK";

  if (titleMarket) claims.push({ marketCode: titleMarket, source: "listing_market_marker", authority: "candidate" });
  return claims;
}

export function authoritativeMarketClaims({ rrpResolution = null, evidence = [] } = {}) {
  const claims = [];
  const rrpMarket = normalizeMarketCode(rrpResolution?.sourceMarket);
  if (rrpResolution?.resolved === true && rrpMarket && rrpResolution?.sourceUrl) {
    claims.push({
      marketCode: rrpMarket,
      source: "authoritative_market_msrp",
      authority: "authoritative",
      sourceUrl: String(rrpResolution.sourceUrl),
      sourceId: rrpResolution.authorityId || null,
    });
  }

  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (item?.kind !== "verified_source_market") continue;
    const marketCode = normalizeMarketCode(item.marketCode || item.value);
    const sourceRole = String(item.sourceRole || "").toLowerCase();
    if (!marketCode || !["manufacturer", "official_store", "authorized_distributor", "operator_verified"].includes(sourceRole)) continue;
    claims.push({
      marketCode,
      source: `verified_source_market:${sourceRole}`,
      authority: "authoritative",
      sourceUrl: item.sourceUrl || null,
      sourceId: item.sourceId || null,
    });
  }
  return claims;
}

function uniqueCodes(claims) {
  return [...new Set((claims || []).map((claim) => normalizeMarketCode(claim?.marketCode)).filter(Boolean))];
}

function rememberedClaim(memory) {
  const marketCode = normalizeMarketCode(memory?.marketCode || memory?.market_code);
  const status = String(memory?.status || "").toLowerCase();
  if (!marketCode || !["verified", "conflict"].includes(status)) return null;
  return { marketCode, status, source: memory.verificationMethod || memory.verification_method || "canonical_market_memory" };
}

export function resolveCanonicalMarket({ remembered = null, listingClaims = [], authoritativeClaims = [] } = {}) {
  const memory = rememberedClaim(remembered);
  const candidateCodes = uniqueCodes(listingClaims);
  const authoritativeCodes = uniqueCodes(authoritativeClaims);
  const evidence = [...listingClaims, ...authoritativeClaims];

  if (memory?.status === "conflict") {
    return { status: "conflict", marketCode: null, candidateMarketCode: memory.marketCode, confidence: 0, source: "memory_conflict_open", evidence };
  }
  if (candidateCodes.length > 1 || authoritativeCodes.length > 1) {
    return { status: "conflict", marketCode: null, candidateMarketCode: null, confidence: 0, source: "market_claim_conflict", evidence };
  }

  const candidateMarketCode = candidateCodes[0] || null;
  const authoritativeMarketCode = authoritativeCodes[0] || null;
  if (memory && ((candidateMarketCode && candidateMarketCode !== memory.marketCode)
    || (authoritativeMarketCode && authoritativeMarketCode !== memory.marketCode))) {
    return { status: "conflict", marketCode: null, candidateMarketCode: authoritativeMarketCode || candidateMarketCode, confidence: 0, source: "remembered_market_conflict", evidence };
  }
  if (candidateMarketCode && authoritativeMarketCode && candidateMarketCode !== authoritativeMarketCode) {
    return { status: "conflict", marketCode: null, candidateMarketCode: authoritativeMarketCode, confidence: 0, source: "listing_authority_conflict", evidence };
  }
  if (authoritativeMarketCode) {
    return {
      status: memory ? "reused" : "verified",
      marketCode: authoritativeMarketCode,
      candidateMarketCode: authoritativeMarketCode,
      confidence: 1,
      source: authoritativeClaims.find((claim) => normalizeMarketCode(claim?.marketCode) === authoritativeMarketCode)?.source || "authoritative_market_evidence",
      evidence,
    };
  }
  if (memory) {
    return { status: "reused", marketCode: memory.marketCode, candidateMarketCode: memory.marketCode, confidence: 1, source: memory.source, evidence };
  }
  if (candidateMarketCode) {
    return { status: "candidate", marketCode: null, candidateMarketCode, confidence: 0.6, source: listingClaims[0]?.source || "listing_market_candidate", evidence };
  }
  return { status: "unknown", marketCode: null, candidateMarketCode: null, confidence: 0, source: "unknown", evidence };
}

export function marketResolutionEvidence(resolution, identity = null, observedAt = Math.floor(Date.now() / 1000)) {
  return [{
    kind: "canonical_market_resolution",
    version: MARKET_MEMORY_VERSION,
    status: resolution?.status || "unknown",
    marketCode: normalizeMarketCode(resolution?.marketCode),
    candidateMarketCode: normalizeMarketCode(resolution?.candidateMarketCode),
    marketGroup: marketGroupForCode(resolution?.marketCode),
    confidence: Number(resolution?.confidence) || 0,
    source: resolution?.source || "unknown",
    productIdentityId: identity?.productIdentityId || null,
    identityResolutionKind: identity?.resolutionKind || null,
    observedAt,
  }];
}
