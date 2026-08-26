import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalRrpRegistry, resolveCanonicalRrp } from "../src/core/canonical-rrp-registry.mjs";
import { shouldQueueUnresolvedRrp } from "../src/core/rrp-learning.mjs";
import { reconcileRrpLearningQueue } from "../src/core/rrp-learning-reconcile.mjs";

const paldeaVaroomAuthority = {
  id: "prd_57f810d1eb0e31da21ebdbc4",
  title: "Pokémon TCG: Scarlet & Violet-Paldea Evolved 3 Booster Packs & Varoom Promo Card",
  productType: "booster_pack",
  tcg: "pokemon",
  officialRrpPence: 1399,
  rrpSource: "pokemon-center-uk",
  rrpObservedAt: 1_787_700_000,
};

test("legacy other-classified 3-pack promo blisters are eligible for RRP learning", () => {
  assert.equal(shouldQueueUnresolvedRrp({
    title: "Scarlet and Violet Paldea Evolved 3 Pack Blister Varoom",
    productType: "other",
    tcg: "pokemon",
  }), true);

  assert.equal(shouldQueueUnresolvedRrp({
    title: "Paldea Evolved 3 Pack Bundle",
    productType: "other",
    tcg: "pokemon",
  }), false);
});

test("Magic Madhouse Paldea Evolved Varoom blister resolves to the verified official £13.99 identity", () => {
  const registry = buildCanonicalRrpRegistry([paldeaVaroomAuthority]);
  const result = resolveCanonicalRrp({
    title: "Scarlet and Violet Paldea Evolved 3 Pack Blister Varoom",
    productType: "other",
    tcg: "pokemon",
  }, registry);

  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 1399);
  assert.equal(result.rrpSource, "pokemon-center-uk");
  assert.deepEqual(result.matchedProductIds, [paldeaVaroomAuthority.id]);
});

test("3-pack blister intelligence is semantic, not a generic three-pack bundle guess", () => {
  const registry = buildCanonicalRrpRegistry([paldeaVaroomAuthority]);
  const result = resolveCanonicalRrp({
    title: "Scarlet and Violet Paldea Evolved 3 Pack Bundle",
    productType: "other",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
});

test("series shorthand never lets a standard ETB inherit a Pokemon Center exclusive RRP", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "pc-chaos-etb",
    title: "Pokémon TCG: Mega Evolution-Chaos Rising Pokémon Center Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 5699,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_787_700_000,
  }]);

  for (const title of [
    "ME Chaos Rising Elite Trainer Box",
    "ME Chaos Rising Elite Trainer Box - Mega Greninja",
  ]) {
    const result = resolveCanonicalRrp({ title, productType: "elite_trainer_box", tcg: "pokemon" }, registry);
    assert.equal(result.resolved, false, title);
  }
});

test("repeated unresolved rows are classified once then deferred until authority or rules change", async () => {
  const updates = [];
  const queue = {
    id: "q-authority-gap",
    tcg: "pokemon",
    retailer_id: "magic-madhouse",
    observed_title: "ME Chaos Rising Elite Trainer Box - Mega Greninja",
    product_type: "elite_trainer_box",
    occurrence_count: 34,
    failure_reason: "no_authoritative_candidate",
    language_code: null,
    region_code: null,
    evidence_json: {},
  };
  const pool = {
    async query(sql, params = []) {
      if (/SELECT \*/.test(sql) && /rrp_resolution_queue/.test(sql)) return { rows: [queue] };
      if (/UPDATE fatedrop_rrp_resolution_queue/.test(sql)) {
        updates.push({ sql, params });
        if (params[0] === "no_authoritative_candidate") {
          queue.failure_reason = params[0];
          queue.evidence_json = { ...queue.evidence_json, ...JSON.parse(params[1]) };
        }
        return { rows: [] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ remaining: 1 }] };
      return { rows: [] };
    },
  };
  const store = {
    async pool() { return pool; },
    async listProducts() { return []; },
  };

  const first = await reconcileRrpLearningQueue({ store, now: 1_787_737_000 });
  assert.equal(first.resolved, 0);
  assert.equal(first.escalated, 1);
  assert.equal(first.deferred, 0);
  const disposition = updates.find(({ params }) => params[0] === "no_authoritative_candidate");
  assert.ok(disposition);
  const evidence = JSON.parse(disposition.params[1]);
  assert.equal(evidence.reconciliation_class, "authority_gap");
  assert.equal(evidence.escalated, true);
  assert.equal(evidence.next_action, "await_or_refresh_authoritative_rrp_source");
  assert.match(evidence.authority_fingerprint, /^rrp-self-heal-v2:/);

  const updateCount = updates.length;
  const second = await reconcileRrpLearningQueue({ store, now: 1_787_738_000 });
  assert.equal(second.resolved, 0);
  assert.equal(second.escalated, 0);
  assert.equal(second.deferred, 1);
  assert.equal(updates.length, updateCount);
});
