import test from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_DISCOVERY_TITLE_PREFIX,
  githubDiscoveryIssueToRows,
  importGithubDiscoveryIssues,
} from "../src/core/discovery-watch-reconcile.mjs";

const PRODUCT_URL = "https://www.pokemoncenter.com/en-gb/product/100-10123/pokemon-tcg-scarlet-and-violet-prismatic-evolutions-booster-bundle-6-packs";

function issue(overrides = {}) {
  const observation = {
    discoveryObservation: true,
    title: "Pokémon TCG: Scarlet & Violet-Prismatic Evolutions Booster Bundle (6 Packs)",
    canonicalUrl: PRODUCT_URL,
    pageExists: true,
    officialPageVerified: true,
    evidenceSource: "pokemon_uk_drop_watch",
    changeType: "new_official_product_page",
    confidence: 0.99,
    availabilityText: "More inventory of this product will become available later this year.",
    rawObservation: "Official product page observed.",
    ...(overrides.observation || {}),
  };
  return {
    number: 268,
    title: `${GITHUB_DISCOVERY_TITLE_PREFIX}${observation.title}`,
    body: JSON.stringify({ retailerId: "pokemon-center-uk", observations: [observation], ...(overrides.body || {}) }),
    created_at: "2026-08-28T20:49:02Z",
    html_url: "https://github.com/Fatez/Fatedrop-Cloud/issues/268",
    ...overrides.issue,
  };
}

test("GitHub Drop Watch transport produces evidence only and uses GitHub creation time", () => {
  const rows = githubDiscoveryIssueToRows(issue());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].retailerId, "pokemon-center-uk");
  assert.equal(rows[0].sourceType, "product_discovery_watch");
  assert.equal(rows[0].sourceUrl, PRODUCT_URL);
  assert.equal(rows[0].observedAt, Math.floor(Date.parse("2026-08-28T20:49:02Z") / 1000));
  assert.equal(rows[0].evidence.discoveredAt, rows[0].observedAt);
  assert.equal(rows[0].evidence.transport.type, "github_issue");
  assert.equal(rows[0].evidence.canonical_pipeline.status, "pending");
  const serialized = JSON.stringify(rows[0].evidence).toLowerCase();
  assert.equal(serialized.includes('"state"'), false);
  assert.equal(serialized.includes('"lifecycle"'), false);
});

test("GitHub Drop Watch transport rejects any attempt to self-declare lifecycle", () => {
  assert.throws(
    () => githubDiscoveryIssueToRows(issue({ observation: { state: "manifested" } })),
    /declare lifecycle state/i,
  );
  assert.throws(
    () => githubDiscoveryIssueToRows(issue({ body: { lifecycle: "vanished" } })),
    /declare lifecycle state/i,
  );
});

test("GitHub Drop Watch transport rejects non-PCUK and non-canonical product URLs", () => {
  assert.throws(
    () => githubDiscoveryIssueToRows(issue({ body: { retailerId: "other-retailer" } })),
    /not Pokémon Center UK/i,
  );
  assert.throws(
    () => githubDiscoveryIssueToRows(issue({ observation: { canonicalUrl: "https://example.com/product/123" } })),
    /canonical Pokémon Center UK product URL/i,
  );
});

test("GitHub import is idempotent and only newer materially changed evidence may replace the ledger row", async () => {
  let stored = null;
  const sqlSeen = [];
  const client = {
    async query(sql, params) {
      sqlSeen.push(sql);
      assert.match(sql, /ON CONFLICT \(retailer_id, source_type, source_url\)/);
      assert.match(sql, /EXCLUDED\.observed_at >= fatedrop_retailer_discovery_evidence\.observed_at/);
      assert.match(sql, /fingerprint/);
      const incoming = {
        evidenceId: params[0],
        retailerId: params[1],
        sourceType: params[2],
        sourceUrl: params[3],
        observedAt: params[4],
        evidence: JSON.parse(params[5]),
      };
      const changed = !stored
        || (incoming.observedAt >= stored.observedAt && incoming.evidence.fingerprint !== stored.evidence.fingerprint);
      if (changed) stored = incoming;
      return { rows: changed ? [{ evidence_id: stored.evidenceId }] : [] };
    },
  };
  let currentIssue = issue();
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => [currentIssue] });

  const first = await importGithubDiscoveryIssues(client, { now: 2000000000, fetchFn, enabled: true, force: true });
  assert.equal(first.imported, 1);
  assert.equal(first.unchanged, 0);

  const second = await importGithubDiscoveryIssues(client, { now: 2000000060, fetchFn, enabled: true, force: true });
  assert.equal(second.imported, 0);
  assert.equal(second.unchanged, 1);

  currentIssue = issue({
    issue: { number: 269, created_at: "2026-08-28T21:00:00Z", html_url: "https://github.com/Fatez/Fatedrop-Cloud/issues/269" },
  });
  const duplicateRetry = await importGithubDiscoveryIssues(client, { now: 2000000090, fetchFn, enabled: true, force: true });
  assert.equal(duplicateRetry.imported, 0);
  assert.equal(duplicateRetry.unchanged, 1);
  assert.equal(stored.observedAt, Math.floor(Date.parse("2026-08-28T20:49:02Z") / 1000));

  currentIssue = issue({
    issue: { number: 270, created_at: "2026-08-28T21:10:00Z", html_url: "https://github.com/Fatez/Fatedrop-Cloud/issues/270" },
    observation: { availabilityText: "Pre-orders are now open.", preorder: true, preorderText: true },
  });
  const changed = await importGithubDiscoveryIssues(client, { now: 2000000120, fetchFn, enabled: true, force: true });
  assert.equal(changed.imported, 1);
  assert.equal(stored.observedAt, Math.floor(Date.parse("2026-08-28T21:10:00Z") / 1000));
  assert.ok(sqlSeen.length >= 4);
});

test("GitHub transport failure remains isolated from the existing reconciler path", async () => {
  const client = { query: async () => { throw new Error("ledger write must not be reached"); } };
  const result = await importGithubDiscoveryIssues(client, {
    now: 2000000200,
    enabled: true,
    force: true,
    fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(result.polled, false);
  assert.match(result.error, /503/);
  assert.equal(result.imported, 0);
});
