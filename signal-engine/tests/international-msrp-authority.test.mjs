import assert from "node:assert/strict";
import test from "node:test";

import { FateVerdictReason } from "../src/core/fate-verdict.mjs";
import { buildRrpValueContext, resolveRrpValue } from "../src/core/rrp-value-reference.mjs";
import { createHttpServer } from "../src/http/server.mjs";
import { resolveInternationalMsrp } from "../src/rrp/international-msrp-authority.mjs";

function pounds(pence) { return pence / 100; }
function closeTo(actual, expected, tolerance = 0.005) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
}

const JP_PACK = "jp_abyss_pack";
const JP_BOX = "jp_abyss_box_30";
const CN_GEM_PACK = "cn_gem6_pack";
const CN_GEM_BOX = "cn_gem6_box_18";
const PLACEHOLDER = "jp_abyss_placeholder";

const products = [
  { id: JP_PACK, canonicalKey: "booster_pack:abyss eye japanese", title: "Pokemon - Mega Evolution - Abyss Eye - Japanese Booster Pack", productType: "booster_pack", tcg: "pokemon" },
  { id: JP_BOX, canonicalKey: "booster_box:abyss eye japanese", title: "Pokemon - Mega Evolution - Abyss Eye - Japanese Booster Box (30 Packs)", productType: "booster_box", tcg: "pokemon" },
  { id: CN_GEM_PACK, canonicalKey: "booster_pack:gem 6 simplified chinese", title: "Pokemon - Gem 6 - Simplified Chinese Booster Pack", productType: "booster_pack", tcg: "pokemon" },
  { id: CN_GEM_BOX, canonicalKey: "booster_box:gem 6 simplified chinese", title: "Pokemon - Gem 6 - Simplified Chinese Booster Box (18 Boosters)", productType: "booster_box", tcg: "pokemon" },
  { id: PLACEHOLDER, canonicalKey: "booster_pack:abyss eye japanese placeholder", title: "Abyss Eye - Japanese Booster Pack", productType: "booster_pack", tcg: "pokemon" },
];

const observedAt = 1787665000;
const offers = [
  { offerId: "off_jp_pack", productId: JP_PACK, retailerId: "jet-cards", retailerName: "JET Cards", retailerSku: "jp-abyss-pack", title: products[0].title, url: "https://example.com/jp-pack", pricePence: 325, postagePence: null, stockStatus: "in_stock", lastSeenAt: observedAt },
  { offerId: "off_jp_box", productId: JP_BOX, retailerId: "jet-cards", retailerName: "JET Cards", retailerSku: "jp-abyss-box", title: products[1].title, url: "https://example.com/jp-box", pricePence: 8495, postagePence: null, stockStatus: "in_stock", lastSeenAt: observedAt },
  { offerId: "off_cn_pack", productId: CN_GEM_PACK, retailerId: "jet-cards", retailerName: "JET Cards", retailerSku: "cn-gem6-pack", title: products[2].title, url: "https://example.com/cn-pack", pricePence: 250, postagePence: null, stockStatus: "in_stock", lastSeenAt: observedAt },
  { offerId: "off_cn_box", productId: CN_GEM_BOX, retailerId: "jet-cards", retailerName: "JET Cards", retailerSku: "cn-gem6-box", title: products[3].title, url: "https://example.com/cn-box", pricePence: 3000, postagePence: null, stockStatus: "in_stock", lastSeenAt: observedAt },
  { offerId: "off_placeholder", productId: PLACEHOLDER, retailerId: "placeholder", retailerName: "Placeholder", retailerSku: "one-penny", title: products[4].title, url: "https://example.com/placeholder", pricePence: 1, postagePence: 0, stockStatus: "in_stock", lastSeenAt: observedAt },
];

const store = {
  async listOffers() { return offers; },
  async listProducts() { return products; },
};

async function withServer(fn) {
  const server = createHttpServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postVerdict(base, query, leftId, rightId) {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query, leftId, rightId }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("Japanese Abyss Eye uses official source-market MSRP and a dated GBP reference", () => {
  const result = resolveInternationalMsrp({ title: products[0].title, productType: "booster_pack" });
  assert.equal(result.recognized, true);
  assert.equal(result.resolved, true);
  assert.equal(result.sourceMarket, "JP");
  assert.equal(result.sourceCurrency, "JPY");
  assert.equal(result.sourceMsrp, 200);
  assert.equal(result.sourceUnitMsrp, 200);
  assert.equal(result.unitCount, 1);
  assert.equal(result.unitKind, "booster_pack");
  assert.equal(result.rrpPence, 92);
  assert.match(result.rrpSource, /official-msrp:jp:jp-abyss-eye/);
  assert.match(result.referenceBasis, /Official Japan MSRP/);
  assert.match(result.referenceBasis, /not a UK RRP/);
});

test("Japanese explicit 30-pack box scales the same official pack MSRP without inventing a box RRP", () => {
  const result = resolveInternationalMsrp({ title: products[1].title, productType: "booster_box" });
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "source_market_component_reference");
  assert.equal(result.unitCount, 30);
  assert.equal(result.sourceMsrp, 6000);
  assert.equal(result.sourceUnitMsrp, 200);
  assert.equal(result.rrpPence, 2762);
  closeTo(pounds(result.rrpPence), 27.62);
});

test("Japanese box without verified quantity fails closed", () => {
  const result = resolveInternationalMsrp({ title: "Abyss Eye - Japanese Booster Box — Sealed", productType: "booster_box" });
  assert.equal(result.recognized, true);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "source_market_box_quantity_unverified");
});

test("Korean exact product authority preserves official pack and box prices", () => {
  const pack = resolveInternationalMsrp({ title: "Pokemon - Mega Evolution - Inferno X - Korean Booster Pack", productType: "booster_pack" });
  const box = resolveInternationalMsrp({ title: "Pokemon - Mega Evolution - Inferno X - Korean Booster Box (30 Packs)", productType: "booster_box" });
  assert.equal(pack.resolved, true);
  assert.equal(pack.sourceCurrency, "KRW");
  assert.equal(pack.sourceMsrp, 1000);
  assert.equal(pack.rrpPence, 53);
  assert.equal(box.resolved, true);
  assert.equal(box.sourceMsrp, 30000);
  assert.equal(box.unitCount, 30);
  assert.equal(box.rrpPence, 1590);
});

test("Simplified Chinese pack formats keep 5-card and 20-card MSRP families distinct", () => {
  const standard = resolveInternationalMsrp({ title: "Pokemon - Blade Awakened - Simplified Chinese Standard Booster Pack", productType: "booster_pack" });
  const jumbo = resolveInternationalMsrp({ title: "Pokemon - Blade Awakened - Simplified Chinese Deluxe Booster Pack", productType: "booster_pack" });
  assert.equal(standard.resolved, true);
  assert.equal(standard.sourceMsrp, 10);
  assert.equal(standard.sourceCardsPerPack, 5);
  assert.equal(standard.rrpPence, 109);
  assert.equal(jumbo.resolved, true);
  assert.equal(jumbo.sourceMsrp, 50);
  assert.equal(jumbo.sourceCardsPerPack, 20);
  assert.equal(jumbo.rrpPence, 545);
  assert.notEqual(standard.referenceFamilyKey, jumbo.referenceFamilyKey);
});

test("Gem 6 18-pack box scales from its verified Simplified Chinese pack MSRP", () => {
  const result = resolveInternationalMsrp({ title: products[3].title, productType: "booster_box" });
  assert.equal(result.resolved, true);
  assert.equal(result.sourceMarket, "CN");
  assert.equal(result.sourceCurrency, "CNY");
  assert.equal(result.unitCount, 18);
  assert.equal(result.sourceUnitMsrp, 10);
  assert.equal(result.sourceMsrp, 180);
  assert.equal(result.rrpPence, 1964);
});

test("ambiguous Chinese region, mystery contents and opened-live imports fail closed", () => {
  const ambiguous = resolveInternationalMsrp({ title: "Abyss Eye - Traditional Chinese Booster Pack", productType: "booster_pack" });
  const mystery = resolveInternationalMsrp({ title: "Japanese Pokemon Mystery Bundle - 4 Sealed Booster Packs", productType: "booster_pack" });
  const opened = resolveInternationalMsrp({ title: "Abyss Eye - Japanese Booster Pack — Opened Live On Stream", productType: "booster_pack" });
  assert.equal(ambiguous.recognized, true);
  assert.equal(ambiguous.resolved, false);
  assert.equal(ambiguous.reason, "source_market_region_unresolved");
  assert.equal(mystery.resolved, false);
  assert.equal(mystery.reason, "source_market_identity_insufficient");
  assert.equal(opened.resolved, false);
  assert.equal(opened.reason, "source_market_opened_live_not_comparable");
});

test("recognized foreign identity never falls through to an unrelated UK authoritative RRP", () => {
  const foreign = {
    id: "foreign-unknown",
    title: "Unknown Future Set - Japanese Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: observedAt,
  };
  const context = buildRrpValueContext([foreign]);
  const result = resolveRrpValue({ title: foreign.title, productType: foreign.productType, linkedProduct: foreign }, context);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_verified_source_market_msrp");
});

test("verified market memory resolves a future listing whose English title has no market marker", () => {
  const result = resolveInternationalMsrp({
    title: "Abyss Eye Booster Pack",
    productType: "booster_pack",
    verifiedMarketCode: "JP",
    marketResolutionStatus: "reused",
  });
  assert.equal(result.recognized, true);
  assert.equal(result.resolved, true);
  assert.equal(result.sourceMarket, "JP");
  assert.equal(result.authorityId, "jp-abyss-eye");
});

test("language alone does not select a market and memory conflicts fail closed", () => {
  const languageOnly = resolveInternationalMsrp({
    title: "Abyss Eye Booster Pack",
    productType: "booster_pack",
    language: "ja",
  });
  assert.equal(languageOnly.recognized, false);

  const conflict = resolveInternationalMsrp({
    title: "Abyss Eye Japanese Booster Pack",
    productType: "booster_pack",
    verifiedMarketCode: "KR",
    marketResolutionStatus: "reused",
  });
  assert.equal(conflict.recognized, true);
  assert.equal(conflict.resolved, false);
  assert.equal(conflict.reason, "source_market_memory_conflict");
});

test("Cloud Fate Verdict compares Japanese 1-pack vs 30-pack on one verified source-market family", async () => withServer(async (base) => {
  const data = await postVerdict(base, "Abyss Eye Japanese", JP_PACK, JP_BOX);
  assert.equal(data.success, true);
  assert.equal(data.mode, "verdict");
  assert.equal(data.source, "FATEDROP_CLOUD");
  const pack = data.groups.find((group) => group.id === JP_PACK);
  const box = data.groups.find((group) => group.id === JP_BOX);
  assert.ok(pack);
  assert.ok(box);
  assert.equal(pack.valueFamilyKey, box.valueFamilyKey);
  assert.notEqual(pack.identityKey, box.identityKey);
  assert.equal(pack.unitCount, 1);
  assert.equal(box.unitCount, 30);
  closeTo(pack.rrpGbp, 0.92);
  closeTo(box.rrpGbp, 27.62);
  assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(data.pairVerdict.winnerId, JP_BOX);
  assert.equal(data.pairVerdict.basis, "rrp_percent");
  assert.match(data.pairVerdict.left.reference.basis, /source-market reference, not a UK RRP/);
}));

test("Cloud Fate Verdict compares Gem 6 pack vs 18-pack box using one CN MSRP family", async () => withServer(async (base) => {
  const data = await postVerdict(base, "Gem 6 Simplified Chinese", CN_GEM_PACK, CN_GEM_BOX);
  const pack = data.groups.find((group) => group.id === CN_GEM_PACK);
  const box = data.groups.find((group) => group.id === CN_GEM_BOX);
  assert.ok(pack);
  assert.ok(box);
  assert.equal(pack.valueFamilyKey, box.valueFamilyKey);
  closeTo(pack.rrpGbp, 1.09);
  closeTo(box.rrpGbp, 19.64);
  assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(data.pairVerdict.winnerId, CN_GEM_BOX);
}));

test("£0.01 import observation remains excluded from True Price and Fate Verdict", async () => withServer(async (base) => {
  const data = await postVerdict(base, "Abyss Eye Japanese");
  assert.equal(data.groups.some((group) => group.id === PLACEHOLDER), false);
  assert.equal(data.verdict.ranking.some((position) => position.groupId === PLACEHOLDER), false);
}));
