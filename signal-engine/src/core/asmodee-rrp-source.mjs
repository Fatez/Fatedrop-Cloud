import { evaluateRrpEvidence } from "./rrp-evidence.mjs";

const POKEMON_PUBLISHER = "the pokemon company int inc";

function fold(value = "") {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBarcode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function normalizeDistributorTitle(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s*\(1\)\s*$/, "")
    .trim();
}

function isAsmodeeUkUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "asmodee.co.uk" || url.hostname === "www.asmodee.co.uk");
  } catch {
    return false;
  }
}

export function normalizeAsmodeePokemonRrpRecord(input = {}) {
  const title = normalizeDistributorTitle(input.title);
  const publisher = fold(input.publisher);
  const distributorSku = String(input.sku ?? "").trim();
  const barcode = normalizeBarcode(input.barcode);
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  const observedAt = Number.isFinite(input.observedAt) ? Math.trunc(input.observedAt) : null;
  const rrpPence = Number.isFinite(input.rrpPence) ? Math.round(input.rrpPence) : null;
  const reasons = [];

  if (!title) reasons.push("missing_title");
  if (publisher !== POKEMON_PUBLISHER) reasons.push("publisher_not_pokemon_company");
  if (!distributorSku) reasons.push("missing_distributor_sku");
  if (!barcode) reasons.push("invalid_or_missing_barcode");
  if (!isAsmodeeUkUrl(sourceUrl)) reasons.push("source_not_asmodee_uk");
  if (!Number.isInteger(rrpPence) || rrpPence <= 0) reasons.push("invalid_rrp");
  if (!observedAt || observedAt <= 0) reasons.push("missing_observed_at");

  if (reasons.length) {
    return { decision: "reject", reasons, evidence: null };
  }

  const evidence = {
    title,
    tcg: "pokemon",
    sourceRole: "authorized_distributor",
    priceKind: "rrp",
    pricePence: rrpPence,
    currency: "GBP",
    sourceName: "Asmodee UK",
    sourceUrl,
    observedAt,
    identifiers: {
      barcode,
      distributor_sku: distributorSku,
    },
  };

  const policy = evaluateRrpEvidence(evidence);
  if (!policy.eligibleForOfficialRrp) {
    return { decision: "reject", reasons: policy.reasons, evidence: null };
  }

  return {
    decision: "eligible",
    reasons: ["asmodee_uk_explicit_rrp_with_pokemon_publisher_and_barcode"],
    evidence,
  };
}
