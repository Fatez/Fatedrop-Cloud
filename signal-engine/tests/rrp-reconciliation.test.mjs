import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRrpEvidence } from "../src/core/rrp-reconciliation.mjs";

const observedAt = Date.UTC(2026, 7, 21);

function manufacturerRrp(title, pricePence, extra = {}) {
  return {
    title,
    sourceRole: "manufacturer",
    priceKind: "rrp",
    pricePence,
    currency: "GBP",
    sourceName: "Official manufacturer",
    sourceUrl: `https://www.pokemon.com/uk/${encodeURIComponent(title)}`,
    observedAt,
    ...extra,
  };
}

function offer(productId, title, productType) {
  return { productId, title, productType, tcg: "pokemon" };
}

test("proposes dry-run assignment only for deterministic authoritative match", () => {
  const report = reconcileRrpEvidence(
    [manufacturerRrp("Pokemon Scarlet & Violet 151 Elite Trainer Box", 4999, { productType: "elite_trainer_box", tcg: "pokemon" })],
    [offer("prd_151_etb", "Pokémon TCG: Scarlet & Violet—151 Elite Trainer Box", "elite_trainer_box")],
  );
  assert.equal(report.summary.safeMatches, 1);
  assert.equal(report.summary.proposedAssignments, 1);
  assert.equal(report.assignments[0].officialRrpPence, 4999);
  assert.equal(report.assignments[0].dryRunOnly, true);
});

test("Pokemon Center RRP cannot flow onto standard ETB", () => {
  const report = reconcileRrpEvidence(
    [manufacturerRrp("Pokemon Center Scarlet & Violet 151 Elite Trainer Box", 5999, { productType: "elite_trainer_box", tcg: "pokemon" })],
    [offer("prd_standard_151", "Pokemon Scarlet & Violet 151 Elite Trainer Box", "elite_trainer_box")],
  );
  assert.equal(report.summary.safeMatches, 0);
  assert.equal(report.summary.rejectedMatches, 1);
  assert.equal(report.summary.proposedAssignments, 0);
});

test("official store selling price can match identity but never becomes RRP assignment", () => {
  const report = reconcileRrpEvidence(
    [{
      title: "Pokemon TCG Sword & Shield Silver Tempest Elite Trainer Box",
      productType: "elite_trainer_box",
      tcg: "pokemon",
      sourceRole: "official_store",
      priceKind: "official_store_price",
      pricePence: 3999,
      currency: "GBP",
      sourceName: "Pokemon Center UK",
      sourceUrl: "https://www.pokemoncenter.com/en-gb/search/mawile",
      observedAt,
    }],
    [offer("prd_silver_tempest", "Pokemon Sword & Shield Silver Tempest Elite Trainer Box", "elite_trainer_box")],
  );
  assert.equal(report.summary.referenceOnlyMatches, 1);
  assert.equal(report.summary.proposedAssignments, 0);
});

test("sealed case evidence cannot assign RRP to single booster box", () => {
  const report = reconcileRrpEvidence(
    [manufacturerRrp("Pokemon Temporal Forces Booster Box Case (6 Booster Boxes)", 72000, { productType: "booster_box", tcg: "pokemon" })],
    [offer("prd_temporal_box", "Pokemon Temporal Forces Booster Box", "booster_box")],
  );
  assert.equal(report.summary.safeMatches, 0);
  assert.equal(report.summary.rejectedMatches, 1);
  assert.equal(report.summary.proposedAssignments, 0);
});

test("Japanese evidence cannot assign RRP to English product", () => {
  const report = reconcileRrpEvidence(
    [manufacturerRrp("Pokemon Black Bolt Japanese Booster Box 20 Packs", 8495, { productType: "booster_box", tcg: "pokemon" })],
    [{ productId: "prd_black_bolt_en", title: "Pokemon Black Bolt English Booster Box 36 Packs", productType: "booster_box", tcg: "pokemon" }],
  );
  assert.equal(report.summary.safeMatches, 0);
  assert.equal(report.summary.rejectedMatches, 1);
});

test("conflicting authoritative RRP evidence blocks assignment", () => {
  const evidence = [
    manufacturerRrp("Pokemon Example Set Elite Trainer Box", 4999, { productType: "elite_trainer_box", tcg: "pokemon" }),
    {
      ...manufacturerRrp("Pokemon Example Set Elite Trainer Box", 5499, { productType: "elite_trainer_box", tcg: "pokemon" }),
      sourceRole: "authorized_distributor",
      sourceName: "Authorized distributor",
      sourceUrl: "https://distributor.example.com/example-etb",
    },
  ];
  const report = reconcileRrpEvidence(evidence, [offer("prd_example_etb", "Pokemon Example Set Elite Trainer Box", "elite_trainer_box")]);
  assert.equal(report.summary.safeMatches, 2);
  assert.equal(report.summary.conflicts, 1);
  assert.equal(report.summary.proposedAssignments, 0);
  assert.deepEqual(report.conflicts[0].prices.sort((a, b) => a - b), [4999, 5499]);
});

test("retailer was-price is rejected before identity reconciliation", () => {
  const report = reconcileRrpEvidence(
    [{
      title: "Pokemon Example Set Elite Trainer Box",
      sourceRole: "retailer",
      priceKind: "was_price",
      pricePence: 7999,
      currency: "GBP",
      sourceName: "Example retailer",
      sourceUrl: "https://retailer.example.com/example-etb",
      observedAt,
    }],
    [offer("prd_example_etb", "Pokemon Example Set Elite Trainer Box", "elite_trainer_box")],
  );
  assert.equal(report.summary.rejectedEvidence, 1);
  assert.equal(report.summary.safeMatches, 0);
  assert.equal(report.summary.proposedAssignments, 0);
});
