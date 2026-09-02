import assert from "node:assert/strict";
import test from "node:test";

import { parseOperatorIssue } from "../src/encounters/operator-local-radar-intake.mjs";

const NOW = Date.parse("2026-09-02T08:00:00+01:00");

function largeAllocationIssue(branchCount = 150) {
  const targetBranches = Array.from(
    { length: branchCount },
    (_, index) => `The Entertainer Regression Branch ${String(index + 1).padStart(3, "0")}`,
  );
  return {
    number: 399,
    state: "open",
    title: "[FATEDROP LOCAL RADAR] large allocation regression",
    body: JSON.stringify({
      schemaVersion: 1,
      retailerId: "entertainer-uk",
      retailerName: "The Entertainer",
      rawProductTitle: "Pokémon TCG: 30th Celebration allocation regression",
      kind: "echo",
      sourceType: "official_retailer_page",
      sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
      sourceLabel: "The Entertainer official Pokémon TCG page",
      explicitTcgRelevance: true,
      expectedFrom: "2026-09-16T00:00:00+01:00",
      expectedTo: "2026-09-16T23:59:59+01:00",
      expectedLabel: "Expected 16 September",
      expiresAt: "2026-09-18T23:59:59+01:00",
      confidence: 0.68,
      targetBranches,
    }),
    created_at: "2026-09-02T07:55:00+01:00",
    updated_at: "2026-09-02T07:55:00+01:00",
    user: { login: "Fatez" },
  };
}

test("operator intake preserves official physical allocations larger than 100 branches", () => {
  const parsed = parseOperatorIssue(largeAllocationIssue(150), NOW);
  assert.equal(parsed.entry.targetBranches.length, 150);
  assert.equal(parsed.entry.targetBranches[0], "The Entertainer Regression Branch 001");
  assert.equal(parsed.entry.targetBranches[149], "The Entertainer Regression Branch 150");
  assert.equal(new Set(parsed.entry.targetBranches).size, 150);
});
