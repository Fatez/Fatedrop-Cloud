import assert from "node:assert/strict";
import test from "node:test";

import { attachLocalAlertIds, confirmedLocalAlertId } from "../src/encounters/local-radar-contract.mjs";
import { normalizeLocalStockObservationBatch } from "../src/encounters/local-stock-store.mjs";

function confirmedShop(overrides = {}) {
  return {
    id: "loc:bromley",
    retailerId: "entertainer-uk",
    name: "The Entertainer Bromley Lower Mall",
    localAvailability: {
      status: "confirmed",
      expected: null,
      confirmed: {
        title: "Pokémon TCG: Mega Forces Tin",
        productIdentityId: "pid:mega-forces-tin",
        observedAt: "2026-08-28T01:00:00.000Z",
        sourceLabel: "Official branch availability",
        sourceUrl: "https://example.invalid/branch-proof",
      },
    },
    ...overrides,
  };
}

test("confirmed Local Radar projection receives a deterministic Cloud-owned alert id", () => {
  const shop = confirmedShop();
  const first = confirmedLocalAlertId(shop);
  const second = confirmedLocalAlertId(structuredClone(shop));
  assert.match(first, /^local-confirmed-[a-f0-9]{24}$/);
  assert.equal(second, first);

  const [projected] = attachLocalAlertIds([shop]);
  assert.equal(projected.localAvailability.confirmed.alertId, first);
});

test("materially new branch confirmation receives a new alert id", () => {
  const first = confirmedLocalAlertId(confirmedShop());
  const later = confirmedLocalAlertId(confirmedShop({
    localAvailability: {
      status: "confirmed",
      expected: null,
      confirmed: {
        ...confirmedShop().localAvailability.confirmed,
        observedAt: "2026-08-28T01:30:00.000Z",
      },
    },
  }));
  assert.notEqual(later, first);
});

test("expected or unknown Local Radar state does not receive a confirmed alert id", () => {
  const [shop] = attachLocalAlertIds([{
    id: "loc:watford",
    retailerId: "entertainer-uk",
    localAvailability: {
      status: "expected",
      expected: { title: "Incoming stock", productIdentityId: "pid:incoming" },
      confirmed: null,
    },
  }]);
  assert.equal(shop.localAvailability.confirmed, null);
});

test("manual physical Manifested still fails closed without exact official verified evidence", () => {
  const weak = normalizeLocalStockObservationBatch([{
    kind: "manifested",
    retailerId: "entertainer-uk",
    locationId: "loc:bromley",
    productIdentityId: "pid:mega-forces-tin",
    occurredAt: Date.parse("2026-08-28T01:00:00Z"),
    evidence: {
      evidenceLevel: "community_report",
      sourceType: "curated_manual",
      sourceId: "manual:test",
      stockStatus: "in_stock",
      availabilityVerified: true,
    },
  }]);
  assert.equal(weak.accepted, 0);
  assert.match(weak.rejected[0].reason, /official branch\/collection\/app evidence/i);

  const verified = normalizeLocalStockObservationBatch([{
    kind: "manifested",
    retailerId: "entertainer-uk",
    locationId: "loc:bromley",
    productIdentityId: "pid:mega-forces-tin",
    occurredAt: Date.parse("2026-08-28T01:00:00Z"),
    evidence: {
      evidenceLevel: "official_branch",
      sourceType: "retailer_submission",
      sourceId: "manual:official-branch:test",
      sourceUrl: "https://example.invalid/branch-proof",
      sourceLabel: "Official branch availability",
      stockStatus: "in_stock",
      availabilityVerified: true,
    },
  }]);
  assert.equal(verified.accepted, 1);
  assert.equal(verified.observations[0].kind, "manifested");
});
