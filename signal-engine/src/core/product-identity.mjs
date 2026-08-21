import { productTypeFromTitle } from "./normalize.mjs";

function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LANGUAGE_PATTERNS = [
  ["japanese", /\b(?:japanese|jpn)\b/],
  ["english", /\benglish\b/],
  ["korean", /\bkorean\b/],
  ["simplified_chinese", /\bsimplified chinese\b/],
  ["traditional_chinese", /\btraditional chinese\b/],
  ["french", /\bfrench\b/],
  ["german", /\bgerman\b/],
  ["italian", /\bitalian\b/],
  ["spanish", /\bspanish\b/],
];

const REGION_PATTERNS = [
  ["uk", /\b(?:uk|united kingdom)\b/],
  ["us", /\b(?:us|usa|united states)\b/],
  ["jp", /\b(?:jp|japan)\b/],
  ["eu", /\b(?:eu|european)\b/],
];

function firstMatch(text, patterns) {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function packCountFrom(text) {
  const patterns = [
    /\b(\d{1,3})\s*x\s*(?:booster\s*)?packs?\b/,
    /\b(\d{1,3})\s*(?:booster\s*)?packs?\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function caseQuantityFrom(text) {
  const patterns = [
    /\bcase\s+of\s+(\d{1,2})\b/,
    /\b(\d{1,2})\s*x\s*(?:booster box|elite trainer box|etb|booster bundle|collection box|tin)s?\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function editionFrom(text) {
  if (/\b(?:1st|first) edition\b/.test(text)) return "first_edition";
  if (/\bunlimited edition\b/.test(text)) return "unlimited";
  return null;
}

function exclusiveFrom(text) {
  if (/\bpokemon center\b/.test(text)) return "pokemon_center";
  return null;
}

function unitKindFrom(text) {
  if (/\b(?:sealed )?(?:case|carton)\b/.test(text)) return "case";
  return "unit";
}

function removeIdentityNoise(text) {
  return ` ${text} `
    .replace(/\bpokemon center\b/g, " ")
    .replace(/\b(?:pokemon|tcg|trading card game|trading cards|cards)\b/g, " ")
    .replace(/\b(?:japanese|jpn|english|korean|simplified chinese|traditional chinese|french|german|italian|spanish)\b/g, " ")
    .replace(/\b(?:uk|united kingdom|us|usa|united states|jp|japan|eu|european)\b/g, " ")
    .replace(/\b(?:1st|first) edition\b/g, " ")
    .replace(/\bunlimited edition\b/g, " ")
    .replace(/\bcase\s+of\s+\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\s*x\s*(?:booster box|elite trainer box|etb|booster bundle|collection box|tin)s?\b/g, " ")
    .replace(/\b\d{1,3}\s*x\s*(?:booster\s*)?packs?\b/g, " ")
    .replace(/\b\d{1,3}\s*(?:booster\s*)?packs?\b/g, " ")
    .replace(/\b(?:elite trainer box|etb|booster display|booster box|booster bundle|sleeved booster|booster pack|premium collection|collection box|collection|tin|league battle deck|battle deck|theme deck|deck box|playmat|portfolio)\b/g, " ")
    .replace(/\b(?:sealed case|case|carton|exclusive)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSignature(core) {
  return core.split(" ").filter(Boolean).sort().join(" ");
}

function normalizeIdentifiers(identifiers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(identifiers || {})) {
    const normalizedKey = fold(key).replace(/ /g, "_");
    const normalizedValue = String(value ?? "").trim().toLowerCase();
    if (normalizedKey && normalizedValue) output[normalizedKey] = normalizedValue;
  }
  return output;
}

export function describeProductIdentity(input) {
  const source = typeof input === "string" ? { title: input } : (input || {});
  const title = String(source.title || "").trim();
  const text = fold(title);
  const productType = source.productType || productTypeFromTitle(title);
  const core = removeIdentityNoise(text);

  return {
    title,
    tcg: source.tcg ? fold(source.tcg).replace(/ /g, "_") : null,
    productType,
    core,
    coreSignature: tokenSignature(core),
    exclusive: exclusiveFrom(text),
    language: source.language || firstMatch(text, LANGUAGE_PATTERNS),
    region: source.region || firstMatch(text, REGION_PATTERNS),
    edition: source.edition || editionFrom(text),
    unitKind: source.unitKind || unitKindFrom(text),
    packCount: Number.isFinite(source.packCount) ? source.packCount : packCountFrom(text),
    caseQuantity: Number.isFinite(source.caseQuantity) ? source.caseQuantity : caseQuantityFrom(text),
    identifiers: normalizeIdentifiers(source.identifiers),
  };
}

function compareOptionalDimension(name, left, right, reasons) {
  if (left != null && right != null && left !== right) {
    reasons.push(`${name}_conflict:${left}:${right}`);
    return "reject";
  }
  if ((left == null) !== (right == null)) {
    reasons.push(`${name}_missing_on_one_side`);
    return "ambiguous";
  }
  return "same";
}

function sharedIdentifierDecision(left, right, reasons) {
  const sharedKeys = Object.keys(left.identifiers).filter((key) => right.identifiers[key]);
  let matched = false;
  for (const key of sharedKeys) {
    if (left.identifiers[key] !== right.identifiers[key]) {
      reasons.push(`identifier_conflict:${key}`);
      return { decision: "reject", matched: false };
    }
    matched = true;
  }
  return { decision: null, matched };
}

export function compareProductIdentity(leftInput, rightInput) {
  const left = describeProductIdentity(leftInput);
  const right = describeProductIdentity(rightInput);
  const reasons = [];

  if (!left.title || !right.title) {
    return { decision: "reject", confidence: 0, reasons: ["missing_title"], left, right };
  }

  if (left.tcg && right.tcg && left.tcg !== right.tcg) {
    return { decision: "reject", confidence: 1, reasons: [`tcg_conflict:${left.tcg}:${right.tcg}`], left, right };
  }

  const identifierDecision = sharedIdentifierDecision(left, right, reasons);
  if (identifierDecision.decision === "reject") {
    return { decision: "reject", confidence: 1, reasons, left, right };
  }

  if (left.productType !== right.productType) {
    reasons.push(`product_type_conflict:${left.productType}:${right.productType}`);
    return { decision: "reject", confidence: 1, reasons, left, right };
  }

  if (left.exclusive !== right.exclusive) {
    reasons.push(`exclusive_conflict:${left.exclusive || "standard"}:${right.exclusive || "standard"}`);
    return { decision: "reject", confidence: 1, reasons, left, right };
  }

  if (left.unitKind !== right.unitKind) {
    reasons.push(`unit_kind_conflict:${left.unitKind}:${right.unitKind}`);
    return { decision: "reject", confidence: 1, reasons, left, right };
  }

  let ambiguous = false;
  for (const [name, a, b] of [
    ["language", left.language, right.language],
    ["region", left.region, right.region],
    ["edition", left.edition, right.edition],
    ["pack_count", left.packCount, right.packCount],
    ["case_quantity", left.caseQuantity, right.caseQuantity],
  ]) {
    const result = compareOptionalDimension(name, a, b, reasons);
    if (result === "reject") return { decision: "reject", confidence: 1, reasons, left, right };
    if (result === "ambiguous") ambiguous = true;
  }

  if (!left.core || !right.core) {
    reasons.push("identity_core_missing");
    return { decision: "ambiguous", confidence: 0.4, reasons, left, right };
  }

  if (left.coreSignature !== right.coreSignature) {
    reasons.push(`identity_core_conflict:${left.core}:${right.core}`);
    return { decision: "reject", confidence: 1, reasons, left, right };
  }

  if (ambiguous) {
    return { decision: "ambiguous", confidence: 0.65, reasons, left, right };
  }

  reasons.push(identifierDecision.matched ? "shared_identifier_and_dimensions_match" : "deterministic_dimensions_match");
  return { decision: "match", confidence: 1, reasons, left, right };
}
