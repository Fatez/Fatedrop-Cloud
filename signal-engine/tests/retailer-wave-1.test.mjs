import test from "node:test";
import assert from "node:assert/strict";

import { ensureApprovedRetailersMonitored } from "../src/retailers/approved-monitor-promotion.mjs";
import { RETAILER_STATES, RRP_AUTHORITY, VERIFICATION_STATES } from "../src/retailers/registry.mjs";
import { RETAILER_WAVE_1_IDS, retailerWave1LaunchRetailers } from "../src/retailers/retailer-wave-1.mjs";

function currentRow(retailer, overrides = {}) {
  return {
    id: retailer.id,
    name: retailer.name,
    websiteUrl: retailer.baseUrl,
    hostname: new URL(retailer.baseUrl).hostname.replace(/^www\./, ""),
    state: RETAILER_STATES.CANDIDATE,
    verification: VERIFICATION_STATES.UNVERIFIED,
    discovery: { source: "user-supplied-csv", discoveredAt: "2026-09-01T10:30:00.000Z", evidence: [] },
    ...overrides,
  };
}

function fakeRegistry(existing = []) {
  const writes = [];
  return {
    writes,
    async list() { return existing; },
    async upsert(row) { writes.push(row); return row; },
  };
}

test("wave 1 is exactly five sealed-only Pokemon stock monitors with no RRP authority", () => {
  const retailers = retailerWave1LaunchRetailers();
  assert.deepEqual(retailers.map((retailer) => retailer.id), RETAILER_WAVE_1_IDS);
  assert.equal(retailers.length, 5);

  for (const retailer of retailers) {
    assert.equal(retailer.enabled, true);
    assert.deepEqual(retailer.tcgs, ["pokemon"]);
    assert.equal(retailer.tcg, "pokemon");
    assert.equal(retailer.catalogue.feedApproved, true);
    assert.ok(retailer.catalogue.feedUrl);
    assert.equal(retailer.rrpAuthority, RRP_AUTHORITY.NONE);
    assert.equal(retailer.officialRrpSource, false);
    assert.equal(retailer.monitoring.cadenceSeconds, 300);
    assert.deepEqual(retailer.monitoring.activeTcgs, ["pokemon"]);
    assert.equal(retailer.include.test("Pokemon Elite Trainer Box"), true);
    assert.equal(retailer.include.test("Pokemon Booster Pack"), true);
    assert.equal(retailer.exclude.test("Pokemon single card"), true);
    assert.equal(retailer.exclude.test("Pokemon event ticket"), true);
    assert.equal(retailer.exclude.test("Pokemon binder accessory"), true);
  }
});

test("approved wave candidates promote to monitored without upgrading verification truth", async () => {
  const retailers = retailerWave1LaunchRetailers();
  const existing = retailers.map((retailer) => currentRow(retailer));
  const registry = fakeRegistry(existing);

  const result = await ensureApprovedRetailersMonitored({ registry, retailers });

  assert.equal(result.promotedCount, 5);
  assert.equal(result.blockedCount, 0);
  assert.equal(registry.writes.length, 5);
  assert.ok(registry.writes.every((row) => row.state === RETAILER_STATES.MONITORED));
  assert.ok(registry.writes.every((row) => row.verification === VERIFICATION_STATES.UNVERIFIED));
  assert.ok(registry.writes.every((row) => row.rrpAuthority === RRP_AUTHORITY.NONE));
  assert.ok(registry.writes.every((row) => row.catalogue.feedApproved === true));
});

test("approved promotion never revives paused, rejected or suspended retailers", async () => {
  const retailers = retailerWave1LaunchRetailers().slice(0, 3);
  const existing = [
    currentRow(retailers[0], { state: RETAILER_STATES.PAUSED }),
    currentRow(retailers[1], { state: RETAILER_STATES.REJECTED }),
    currentRow(retailers[2], { verification: VERIFICATION_STATES.SUSPENDED }),
  ];
  const registry = fakeRegistry(existing);

  const result = await ensureApprovedRetailersMonitored({ registry, retailers });

  assert.equal(result.promotedCount, 0);
  assert.equal(result.blockedCount, 3);
  assert.equal(registry.writes.length, 0);
});

test("approved promotion fails closed on hostname identity conflict", async () => {
  const retailer = retailerWave1LaunchRetailers()[0];
  const registry = fakeRegistry([currentRow(retailer, { hostname: "wrong.example" })]);

  await assert.rejects(
    () => ensureApprovedRetailersMonitored({ registry, retailers: [retailer] }),
    /hostname conflicts/i,
  );
  assert.equal(registry.writes.length, 0);
});

test("approved promotion refuses an unapproved structured feed", async () => {
  const retailer = retailerWave1LaunchRetailers()[0];
  const unsafe = { ...retailer, catalogue: { ...retailer.catalogue, feedApproved: false } };
  const registry = fakeRegistry([currentRow(retailer)]);

  await assert.rejects(
    () => ensureApprovedRetailersMonitored({ registry, retailers: [unsafe] }),
    /explicitly approved structured feed/i,
  );
  assert.equal(registry.writes.length, 0);
});
