import crypto from "node:crypto";

const stopWords = new Set(["pokemon", "pokémon", "tcg", "trading", "card", "game", "cards"]);

export function normalizeWhitespace(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeTitle(value = "") {
  const text = normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return text
    .split(" ")
    .filter((token) => token && !stopWords.has(token))
    .join(" ");
}

export function canonicalKey(title, productType = "other") {
  const normalized = normalizeTitle(title);
  return `${productType}:${normalized}`;
}

export function stableId(prefix, ...parts) {
  const hash = crypto.createHash("sha256").update(parts.join("\u241f")).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

export function parseMoneyToPence(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  const raw = normalizeWhitespace(value).replace(/,/g, "");
  const match = raw.match(/(?:£|GBP\s*)?([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

export function productTypeFromTitle(title = "") {
  const t = normalizeTitle(title);
  if (/elite trainer box|\betb\b/.test(t)) return "elite_trainer_box";
  if (/booster display|booster box/.test(t)) return "booster_box";
  if (/booster bundle/.test(t)) return "booster_bundle";
  if (/booster pack|sleeved booster/.test(t)) return "booster_pack";
  if (/collection|premium collection|box/.test(t)) return "collection_box";
  if (/\btin\b/.test(t)) return "tin";
  if (/battle deck|theme deck|league battle deck/.test(t)) return "deck";
  if (/sleeves|binder|deck box|playmat|portfolio/.test(t)) return "accessory";
  return "other";
}

export function markupPercent(pricePence, rrpPence) {
  if (!Number.isFinite(pricePence) || !Number.isFinite(rrpPence) || rrpPence <= 0) return null;
  return Math.round((((pricePence - rrpPence) / rrpPence) * 100) * 10) / 10;
}
