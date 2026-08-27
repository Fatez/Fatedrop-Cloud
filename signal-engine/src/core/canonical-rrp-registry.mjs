import { compareProductIdentity, describeProductIdentity } from "./product-identity.mjs";

function authoritative(product = {}) {
  return Number.isFinite(product.officialRrpPence)
    && product.officialRrpPence > 0
    && typeof product.rrpSource === "string"
    && product.rrpSource.trim().length > 0;
}

function normalizeThreePackPromoBlister(source, title) {
  const patterns = [
    /^(.*?)\b3\s*[- ]?pack\s+blister(?:\s+pack)?\s*[-:–—]?\s*([a-z0-9][a-z0-9' -]*)$/i,
    /^(.*?)\btriple\s+blister\s*[-:–—]?\s*([a-z0-9][a-z0-9' -]*)$/i,
    /^(.*?)\b3\s*[- ]?pack\s+booster\s*[-:–—]\s*([a-z0-9][a-z0-9' -]*)$/i,
  ];
  for (const pattern of patterns) {
    const match = String(title || "").match(pattern);
    if (!match) continue;
    const prefix = String(match[1] || "").trim().replace(/[-:–—]+$/, "").trim();
    const promo = String(match[2] || "")
      .replace(/\bpromo(?:\s+card)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!prefix || !promo) continue;
    return {
      ...source,
      title: `${prefix} 3 Booster Packs & ${promo} Promo Card`,
      productType: "booster_pack",
    };
  }
  return source;
}

function normalizePokemonSeriesWording(title = "") {
  return String(title || "")
    // Retailers often abbreviate Scarlet & Violet to SV. Restrict this to a
    // standalone prefix so set codes such as SV8 are not silently rewritten.
    .replace(/\bSV\b(?=\s+[A-Za-z])/g, " Scarlet & Violet ")
    // Asmodee commonly includes the expansion sequence (for example 8.5 or 10)
    // while retailer titles omit it. The named expansion still carries identity,
    // so the sequence number is safe to ignore for RRP matching only.
    .replace(/\bScarlet\s*(?:&|and)\s*Violet\s+\d{1,2}(?:\.\d+)?\b/gi, " Scarlet & Violet ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripEraPrefixWhenExpansionRemains(source, title = "") {
  const productType = String(source?.productType || "").trim().toLowerCase();
  // A loose retailer booster-pack title is intentionally allowed to use a
  // clearly-labelled pack reference without becoming an exact official product
  // identity. Removing the era prefix here would silently upgrade that reference
  // into official-RRP inheritance, so booster packs keep the stricter v3 boundary.
  if (productType === "booster_pack") return String(title || "");

  let value = String(title || "");
  const patterns = [
    /\bSword\s*(?:&|and)\s*Shield\b/gi,
    /\bScarlet\s*(?:&|and)\s*Violet\b/gi,
  ];
  for (const pattern of patterns) {
    if (!pattern.test(value)) continue;
    pattern.lastIndex = 0;
    const stripped = value.replace(pattern, " ").replace(/\s+/g, " ").trim();
    const descriptor = describeProductIdentity({ ...source, title: stripped });
    // Never erase the identity of a base-set product such as "Sword & Shield ETB"
    // or "Scarlet & Violet ETB". Era wording is ignored only when a distinct
    // expansion identity remains after normal product noise is removed.
    if (descriptor.coreSignature) value = stripped;
  }
  return value;
}

function normalizePokemonPackagingWording(source, title = "") {
  let value = String(title || "");
  const productType = String(source?.productType || "").trim().toLowerCase();

  // Retailers sometimes repeat the V marker after the named Pokemon on V Battle
  // Deck listings, while the official catalogue title omits that trailing marker.
  // Scope the cleanup to explicit V Battle Decks only; do not collapse V/ex names
  // across unrelated decks.
  if (productType === "deck" && /\bV\s+Battle\s+Deck\b/i.test(value)) {
    value = value.replace(/\s+V\s*$/i, "");
  }

  // CDU (counter display unit) is retailer packaging language for the same booster
  // box unit, not a distinct consumer RRP identity. Case/carton quantities remain
  // protected by the normal product-identity dimensions.
  if (productType === "booster_box") {
    value = value.replace(/\s*[-:–—]?\s*CDU\s*$/i, "");
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeRrpAliasInput(input = {}) {
  const source = typeof input === "string" ? { title: input } : (input || {});
  const title = String(source.title || "");
  const tcg = String(source.tcg || "pokemon").trim().toLowerCase();

  // Keep retailer naming aliases local to RRP resolution. This preserves the raw
  // catalogue title/evidence while allowing verified official identities to be
  // reused safely across common retailer wording differences.
  let normalized = { ...source, title };
  if (tcg === "pokemon") {
    normalized = normalizeThreePackPromoBlister(normalized, normalized.title);
    normalized.title = normalizePokemonSeriesWording(String(normalized.title || "")
      .replace(/\bSWSH\b/gi, " Sword & Shield ")
      .replace(/\bBooster\s+Display\s+Box\b/gi, " Booster Box "));
    normalized.title = stripEraPrefixWhenExpansionRemains(normalized, normalized.title);
    normalized.title = normalizePokemonPackagingWording(normalized, normalized.title);
  }

  // Retailers frequently publish the same Pokemon expansion using a set code or
  // series prefix while the official catalogue uses the long expansion name.
  // Keep these aliases local to RRP identity resolution so catalogue titles and
  // evidence remain untouched. Add only verified aliases; never fuzzy-match them.
  if (tcg === "pokemon" && /\bchaos[\s-]+rising\b/i.test(normalized.title)) {
    normalized.title = normalized.title
      .replace(/\bME\s*0?4\b/gi, " ")
      .replace(/\bME\b(?=\s+Chaos[\s-]+Rising\b)/gi, " ")
      .replace(/\bMega\s+Evolution(?:\s+4)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (tcg === "pokemon" && /\bascended[\s-]+heroes\b/i.test(normalized.title)) {
    normalized.title = normalized.title
      .replace(/\bME\b(?=\s+Ascended[\s-]+Heroes\b)/gi, " ")
      .replace(/\bMega\s+Evolution(?:\s+2(?:\.5)?)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return normalized;
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
