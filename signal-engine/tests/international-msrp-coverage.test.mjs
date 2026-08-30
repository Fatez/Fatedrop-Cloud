import assert from "node:assert/strict";
import test from "node:test";

import { resolveInternationalMsrp } from "../src/rrp/international-msrp-authority.mjs";

const japaneseBoxes = [
  {
    title: "Pokemon - Sun & Moon - Japanese - Tag Team GX All Stars SM12a Booster Box",
    sourceMsrp: 5500,
    unitMsrp: 550,
    packs: 10,
    rrpPence: 2532,
  },
  {
    title: "Pokemon - Sun & Moon - Remix Bout SM11a Booster Box - Japanese",
    sourceMsrp: 4860,
    unitMsrp: 162,
    packs: 30,
    rrpPence: 2237,
  },
  {
    title: "Pokemon - Sword & Shield - Legendary Heartbeat S3a Booster Box - Japanese",
    sourceMsrp: 5060,
    unitMsrp: 253,
    packs: 20,
    rrpPence: 2329,
  },
  {
    title: "Pokemon - Sword & Shield - VMAX Rising S1a Booster Box - Japanese",
    sourceMsrp: 4950,
    unitMsrp: 165,
    packs: 30,
    rrpPence: 2279,
  },
];

for (const expected of japaneseBoxes) {
  test(`resolves historical Japanese sealed box authority: ${expected.title}`, () => {
    const result = resolveInternationalMsrp({ title: expected.title, productType: "booster_box" });
    assert.equal(result.recognized, true);
    assert.equal(result.resolved, true);
    assert.equal(result.sourceMarket, "JP");
    assert.equal(result.sourceCurrency, "JPY");
    assert.equal(result.kind, "source_market_component_reference");
    assert.equal(result.sourceMsrp, expected.sourceMsrp);
    assert.equal(result.sourceUnitMsrp, expected.unitMsrp);
    assert.equal(result.unitCount, expected.packs);
    assert.equal(result.rrpPence, expected.rrpPence);
    assert.match(result.referenceBasis, /source-market reference, not a UK RRP/i);
  });
}

test("Premium Trainer Box MEGA uses its direct official Japanese product MSRP", () => {
  const result = resolveInternationalMsrp({
    title: "Pokemon - Mega Evolution - Japanese - Premium Trainer Box MEGA",
    productType: "collection_box",
  });
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "source_market_msrp");
  assert.equal(result.sourceMarket, "JP");
  assert.equal(result.sourceMsrp, 6350);
  assert.equal(result.rrpPence, 2923);
  assert.equal(result.unitCount, 1);
  assert.equal(result.unitKind, "collection_box");
  assert.equal(result.sourceCardsPerPack, null);
  assert.match(result.rrpSource, /jp-premium-trainer-box-mega/);
});

test("Fukuoka Special Box direct authority beats the generic Mega Dream ex set alias", () => {
  const result = resolveInternationalMsrp({
    title: "Pokemon - MEGA - Mega Dream ex M2A - Pokemon Center Fukuoka Special Box - Japanese",
    productType: "collection_box",
  });
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "source_market_msrp");
  assert.equal(result.sourceMsrp, 2090);
  assert.equal(result.rrpPence, 962);
  assert.match(result.rrpSource, /jp-pokemon-center-fukuoka-special-box/);
  assert.doesNotMatch(result.rrpSource, /jp-mega-dream-ex/);
});

test("live Simplified Chinese Terastal Grand Gathering 10-pack box uses official 10-card pack MSRP", () => {
  const result = resolveInternationalMsrp({
    title: "Pokemon - Simplified Chinese - Terastal Grand Gathering - Booster Box (10 Packs)",
    productType: "booster_box",
  });
  assert.equal(result.recognized, true);
  assert.equal(result.resolved, true);
  assert.equal(result.sourceMarket, "CN");
  assert.equal(result.sourceCurrency, "CNY");
  assert.equal(result.kind, "source_market_component_reference");
  assert.equal(result.sourceUnitMsrp, 30);
  assert.equal(result.sourceCardsPerPack, 10);
  assert.equal(result.unitCount, 10);
  assert.equal(result.sourceMsrp, 300);
  assert.equal(result.rrpPence, 3273);
});

test("opened-live Japanese listings remain deliberately unverified after coverage expansion", () => {
  const result = resolveInternationalMsrp({
    title: "Pokemon - Sword & Shield - VMAX Rising S1a Booster Box - Japanese - Opened Live On Stream",
    productType: "booster_box",
  });
  assert.equal(result.recognized, true);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "source_market_opened_live_not_comparable");
});

test("verified Korean official authorities preserve exact native pack and box MSRP", () => {
  const cases = [
    ["Pokemon Card 151 - Korean Booster Box", 50000, 20, 2649],
    ["Pokemon - Terastal Festival ex - Korean Booster Box", 50000, 10, 2649],
    ["Pokemon - Battle Partners - Korean Booster Box", 30000, 30, 1590],
    ["Pokemon - Heat Wave Arena - Korean Booster Box", 30000, 30, 1590],
    ["Pokemon - Team Rocket Glory - Korean Booster Box", 30000, 30, 1590],
    ["Pokemon - Nihil Zero - Korean Booster Box", 30000, 30, 1590],
    ["Pokemon - Ninja Spinner - Korean Booster Box", 30000, 30, 1590],
  ];

  for (const [title, sourceMsrp, packs, rrpPence] of cases) {
    const result = resolveInternationalMsrp({ title, productType: "booster_box" });
    assert.equal(result.resolved, true, title);
    assert.equal(result.sourceMarket, "KR", title);
    assert.equal(result.sourceCurrency, "KRW", title);
    assert.equal(result.sourceMsrp, sourceMsrp, title);
    assert.equal(result.unitCount, packs, title);
    assert.equal(result.rrpPence, rrpPence, title);
  }
});