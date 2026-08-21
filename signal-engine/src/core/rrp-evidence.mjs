const SOURCE_ROLES = new Set([
  "manufacturer",
  "official_store",
  "authorized_distributor",
  "retailer",
]);

const PRICE_KINDS = new Set([
  "rrp",
  "msrp",
  "official_store_price",
  "list_price",
  "was_price",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedCurrency(value) {
  return clean(value || "GBP").toUpperCase();
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function evaluateRrpEvidence(input = {}) {
  const sourceRole = clean(input.sourceRole).toLowerCase();
  const priceKind = clean(input.priceKind).toLowerCase();
  const currency = normalizedCurrency(input.currency);
  const sourceUrl = validHttpsUrl(input.sourceUrl);
  const title = clean(input.title);
  const sourceName = clean(input.sourceName);
  const observedAt = Number.isFinite(input.observedAt) ? Math.trunc(input.observedAt) : null;
  const pricePence = Number.isFinite(input.pricePence) ? Math.round(input.pricePence) : null;
  const reasons = [];

  if (!title) reasons.push("missing_product_title");
  if (!SOURCE_ROLES.has(sourceRole)) reasons.push("invalid_source_role");
  if (!PRICE_KINDS.has(priceKind)) reasons.push("invalid_price_kind");
  if (!sourceUrl) reasons.push("invalid_or_non_https_source_url");
  if (!observedAt || observedAt <= 0) reasons.push("missing_observed_at");
  if (!Number.isInteger(pricePence) || pricePence <= 0) reasons.push("invalid_price");

  if (reasons.length) {
    return {
      decision: "reject",
      eligibleForOfficialRrp: false,
      referenceOnly: false,
      officialRrpPence: null,
      reasons,
      normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl?.href ?? null, observedAt, pricePence },
    };
  }

  if (currency !== "GBP") {
    return {
      decision: "reject",
      eligibleForOfficialRrp: false,
      referenceOnly: false,
      officialRrpPence: null,
      reasons: [`foreign_currency_for_uk_rrp:${currency}`],
      normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl.href, observedAt, pricePence },
    };
  }

  const authoritativeSource = sourceRole === "manufacturer"
    || sourceRole === "official_store"
    || sourceRole === "authorized_distributor";
  const explicitRecommendedPrice = priceKind === "rrp" || priceKind === "msrp";

  if (authoritativeSource && explicitRecommendedPrice) {
    return {
      decision: "eligible",
      eligibleForOfficialRrp: true,
      referenceOnly: false,
      officialRrpPence: pricePence,
      reasons: [`explicit_${priceKind}_from_${sourceRole}`],
      normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl.href, observedAt, pricePence },
    };
  }

  if (sourceRole === "official_store" && priceKind === "official_store_price") {
    return {
      decision: "reference_only",
      eligibleForOfficialRrp: false,
      referenceOnly: true,
      officialRrpPence: null,
      reasons: ["official_store_selling_price_is_not_explicit_rrp"],
      normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl.href, observedAt, pricePence },
    };
  }

  if (sourceRole === "retailer") {
    return {
      decision: "reject",
      eligibleForOfficialRrp: false,
      referenceOnly: false,
      officialRrpPence: null,
      reasons: [`retailer_${priceKind}_cannot_establish_official_rrp`],
      normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl.href, observedAt, pricePence },
    };
  }

  return {
    decision: "reject",
    eligibleForOfficialRrp: false,
    referenceOnly: false,
    officialRrpPence: null,
    reasons: [`unsupported_price_evidence:${sourceRole}:${priceKind}`],
    normalized: { title, sourceRole, priceKind, currency, sourceName, sourceUrl: sourceUrl.href, observedAt, pricePence },
  };
}
