function clean(value, max = 500) {
  const result = String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
}

function key(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(values, maxItems = 500) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 500)).filter(Boolean))].slice(0, maxItems);
}

function productHeading(line) {
  const value = String(line || "");
  return /pok[eé]mon/i.test(value)
    && /tcg|trading card|30th celebration/i.test(value)
    && /booster|elite trainer|\betb\b|tin\b|collection|blister|bundle|box\b|pack\b|deck\b|ultra premium|poster|battle|celebration/i.test(value);
}

const RELEASE = /^(?:released?|release date|releases?|available|expected|delayed|launch(?:es|ing)?)(?:\s*:|\s+-|\s+–)?/i;
const LIMIT = /limited\s+to\s+\d+\s+(?:per|\/)?\s*customer/i;
const LIMITED_ALLOCATION = /only\s+stores?\s+listed\s+will\s+receive\s+limited\s+stock/i;
const DISCLAIMER = /cannot\s+guarantee.+stock.+arrival|subject\s+to\s+availability|available\s+while\s+stocks\s+last/i;
const BRANCH = /^The Entertainer\s+.+/i;
const ALLOCATION_GROUP = /\ballocation\s+(?:group|wave|tier)\b|\bgroup\s+[a-z0-9]+\b/i;

function releaseLabel(section) {
  for (let index = 0; index < section.length; index += 1) {
    const line = section[index];
    if (!RELEASE.test(line)) continue;
    if (/\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+|end\s+of\s+[A-Za-z]+/i.test(line)) return clean(line, 180);
    const next = section[index + 1];
    if (next && /\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+|end\s+of\s+[A-Za-z]+/i.test(next)) return clean(`${line} ${next}`, 180);
    return clean(line, 180);
  }
  return null;
}

function purchaseLimit(section) {
  return clean(section.find((line) => LIMIT.test(line)), 140);
}

function allocationGroup(section) {
  return clean(section.find((line) => ALLOCATION_GROUP.test(line)), 140);
}

function canonicalStoreUrlMap(links = []) {
  const result = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    const text = clean(link?.text, 200);
    const href = clean(link?.href, 700);
    if (!text || !href || !BRANCH.test(text)) continue;
    try {
      const url = new URL(href, "https://www.thetoyshop.com");
      if (url.hostname !== "www.thetoyshop.com" && url.hostname !== "thetoyshop.com") continue;
      if (!url.pathname.startsWith("/store/")) continue;
      url.hash = "";
      result.set(key(text), url.toString());
    } catch { /* ignore malformed links */ }
  }
  return result;
}

function assetHints(images = [], title) {
  const titleKey = key(title);
  const hints = [];
  for (const image of Array.isArray(images) ? images : []) {
    const alt = clean(image?.alt, 300);
    const src = clean(image?.src, 1000);
    if (!src) continue;
    if (alt && titleKey && !key(alt).includes(titleKey) && !titleKey.includes(key(alt))) continue;
    const path = (() => { try { return new URL(src, "https://www.thetoyshop.com").pathname; } catch { return src; } })();
    const ids = [...path.matchAll(/(?:^|[^0-9])(\d{5,})(?:[^0-9]|$)/g)].map((match) => match[1]);
    for (const id of ids) hints.push(id);
  }
  return unique(hints, 10);
}

function campaignTitle({ headings = [], pageTitle = "", products = [] } = {}) {
  const candidates = unique(headings, 100)
    .filter((heading) => /30th\s+celebration|pokemon.+celebration|mega forces|ascended heroes/i.test(heading));
  if (candidates.length) return clean(candidates[0], 220);
  const productTitles = products.map((product) => product.title).join(" ");
  if (/30th\s+celebration/i.test(productTitles)) return "Pokémon TCG: 30th Celebration";
  return clean(pageTitle, 220) || "Pokémon at The Entertainer";
}

export function parseEntertainerPokemonAllocationSurface(input = {}) {
  const lines = String(input.renderedText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line, 600))
    .filter(Boolean);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) if (productHeading(lines[index])) starts.push(index);

  const stores = canonicalStoreUrlMap(input.links);
  const products = [];
  const seen = new Set();
  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position];
    const end = starts[position + 1] ?? lines.length;
    const section = lines.slice(start, end);
    const title = clean(lines[start], 240);
    const productKey = key(title);
    if (!title || !productKey || seen.has(productKey)) continue;
    const branches = unique(section.filter((line) => BRANCH.test(line)), 300).sort((a, b) => a.localeCompare(b));
    if (!branches.length) continue;
    seen.add(productKey);
    products.push({
      title,
      releaseLabel: releaseLabel(section),
      allocationGroup: allocationGroup(section),
      purchaseLimit: purchaseLimit(section),
      allocationLimited: section.some((line) => LIMITED_ALLOCATION.test(line)),
      branchTargets: branches.map((name) => ({ name, storeUrl: stores.get(key(name)) || null })),
      assetReferenceHints: assetHints(input.images, title),
    });
  }

  const warnings = [];
  if (!DISCLAIMER.test(String(input.renderedText || ""))) warnings.push("availability_disclaimer_not_detected");
  if (!products.length) warnings.push("no_branch_addressable_products");
  const missingStoreUrls = products.reduce((sum, product) => sum + product.branchTargets.filter((branch) => !branch.storeUrl).length, 0);
  if (missingStoreUrls) warnings.push("canonical_store_urls_incomplete");

  return {
    parserVersion: 1,
    campaignTitle: campaignTitle({ headings: input.headings, pageTitle: input.pageTitle, products }),
    availabilityDisclaimerPresent: DISCLAIMER.test(String(input.renderedText || "")),
    storeSearchSemantics: "static_filter_only_not_inventory",
    products,
    warnings,
    diagnostics: {
      renderedLines: lines.length,
      productHeadingsSeen: starts.length,
      productsWithNamedAllocations: products.length,
      branchTargets: products.reduce((sum, product) => sum + product.branchTargets.length, 0),
      canonicalStoreUrls: products.reduce((sum, product) => sum + product.branchTargets.filter((branch) => branch.storeUrl).length, 0),
      assetReferenceHints: products.reduce((sum, product) => sum + product.assetReferenceHints.length, 0),
    },
  };
}

export function parseRetailerIntelligenceSurface(input = {}) {
  switch (String(input.surfaceId || "")) {
    case "entertainer-pokemon-drop-hub":
      return parseEntertainerPokemonAllocationSurface(input);
    default:
      throw new Error("No parser is registered for this retailer intelligence surface");
  }
}
