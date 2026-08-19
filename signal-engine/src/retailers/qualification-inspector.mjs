import { load } from "cheerio";
import { fetchCataloguePage } from "../core/fetch.mjs";
import { inferAdapterFromEvidence } from "./onboarding.mjs";
import { normalizeRetailerCandidate } from "./registry.mjs";

function absoluteUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function rankedLinks(html, baseUrl, terms, limit = 10) {
  const $ = load(html);
  const rows = [];
  const seen = new Set();
  $("a[href]").each((_, node) => {
    const href = absoluteUrl($(node).attr("href"), baseUrl);
    if (!href || seen.has(href)) return;
    let parsed;
    try { parsed = new URL(href); } catch { return; }
    const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
    if (parsed.hostname.replace(/^www\./, "") !== baseHost) return;
    const text = `${$(node).text()} ${parsed.pathname}`.toLowerCase();
    let score = 0;
    const matched = [];
    for (const term of terms) {
      if (text.includes(term.value)) { score += term.weight; matched.push(term.value); }
    }
    if (!score) return;
    seen.add(href);
    rows.push({ url: href, text: $(node).text().trim().slice(0, 120), score, matched });
  });
  return rows.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, limit);
}

const catalogueTerms = [
  { value: "pokemon", weight: 10 },
  { value: "pokémon", weight: 10 },
  { value: "trading card", weight: 9 },
  { value: "tcg", weight: 9 },
  { value: "card game", weight: 7 },
  { value: "sealed", weight: 5 },
  { value: "booster", weight: 4 },
  { value: "collectable", weight: 3 },
  { value: "collectible", weight: 3 },
];

const deliveryTerms = [
  { value: "delivery", weight: 10 },
  { value: "shipping", weight: 10 },
  { value: "postage", weight: 10 },
  { value: "dispatch", weight: 5 },
];

function platformEvidence(html = "") {
  const lower = html.toLowerCase();
  const evidence = [];
  if (/cdn\.shopify|myshopify|shopify\.theme|shopify-section/.test(lower)) evidence.push("shopify-html-marker");
  if (/woocommerce|wp-content\/plugins\/woocommerce|wc-ajax/.test(lower)) evidence.push("woocommerce-html-marker");
  return evidence;
}

export async function inspectRetailerWebsite(input, { fetchPage = fetchCataloguePage } = {}) {
  const retailer = normalizeRetailerCandidate(input);
  if (!retailer.websiteUrl) throw new Error("Retailer website is required for qualification inspection");
  const response = await fetchPage(retailer.websiteUrl);
  const html = response.html || "";
  const evidence = platformEvidence(html);
  return {
    retailerId: retailer.id,
    websiteUrl: retailer.websiteUrl,
    status: response.status,
    adapterSuggestion: inferAdapterFromEvidence({ html }),
    platformEvidence: evidence,
    catalogueCandidates: rankedLinks(html, retailer.websiteUrl, catalogueTerms, 12),
    deliveryPolicyCandidates: rankedLinks(html, retailer.websiteUrl, deliveryTerms, 8),
    inspectedAt: new Date().toISOString(),
    note: "Qualification evidence only; no feed endpoint or monitoring approval is inferred.",
  };
}
