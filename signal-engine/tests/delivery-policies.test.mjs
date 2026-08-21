import test from "node:test";
import assert from "node:assert/strict";
import { resolveRetailerDelivery } from "../src/core/delivery-policies.mjs";

test("Pokémon Center UK resolves flat fee below threshold and free delivery at £20", () => {
  assert.equal(resolveRetailerDelivery({ retailerId: "pokemon-center-uk", subtotalPence: 1999 }).postagePence, 500);
  assert.equal(resolveRetailerDelivery({ retailerId: "pokemon-center-uk", subtotalPence: 2000 }).postagePence, 0);
});

test("Smyths resolves order-value tiers", () => {
  assert.equal(resolveRetailerDelivery({ retailerId: "smyths-uk", subtotalPence: 999 }).postagePence, 499);
  assert.equal(resolveRetailerDelivery({ retailerId: "smyths-uk", subtotalPence: 1500 }).postagePence, 299);
  assert.equal(resolveRetailerDelivery({ retailerId: "smyths-uk", subtotalPence: 2000 }).postagePence, 0);
});

test("Eterna resolves tracked delivery tiers", () => {
  assert.equal(resolveRetailerDelivery({ retailerId: "eterna-cards", subtotalPence: 7999 }).postagePence, 295);
  assert.equal(resolveRetailerDelivery({ retailerId: "eterna-cards", subtotalPence: 8000 }).postagePence, 195);
  assert.equal(resolveRetailerDelivery({ retailerId: "eterna-cards", subtotalPence: 20000 }).postagePence, 0);
});

test("threshold-only retailers remain unknown below a verified free-shipping threshold", () => {
  const below = resolveRetailerDelivery({ retailerId: "chaos-cards", subtotalPence: 2500 });
  const above = resolveRetailerDelivery({ retailerId: "chaos-cards", subtotalPence: 3001 });
  assert.equal(below.known, false);
  assert.equal(below.postagePence, null);
  assert.equal(above.known, true);
  assert.equal(above.postagePence, 0);
});

test("dynamic grocery delivery remains unknown", () => {
  assert.equal(resolveRetailerDelivery({ retailerId: "tesco-uk", subtotalPence: 5000 }).known, false);
  assert.equal(resolveRetailerDelivery({ retailerId: "asda-uk", subtotalPence: 5000 }).known, false);
});
