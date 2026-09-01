import assert from "node:assert/strict";
import test from "node:test";

import { buildIdentityFacetAudit } from "../src/telemetry/identity-facet-audit.mjs";

test("unknown facet audit separates unresolved, partial, conflict and broad-family holes", () => {
  const now = 1_800_000_000;
  const audit = buildIdentityFacetAudit([
    {
      record_kind: "signal",
      signal_id: "sig-generic",
      offer_id: "offer-generic-a",
      canonical_product_id: "prd-generic",
      canonical_key: "booster_box:generic moonlight",
      retailer_id: "shop-a",
      retailer_name: "Shop A",
      tcg: "pokemon",
      title: "Pokémon Booster Box",
      observed_at: now - 100,
      evidence: [],
    },
    {
      record_kind: "offer",
      offer_id: "offer-generic-b",
      canonical_product_id: "prd-generic",
      canonical_key: "booster_box:generic moonlight",
      retailer_id: "shop-b",
      retailer_name: "Shop B",
      tcg: "pokemon",
      title: "Pokémon Booster Box",
      observed_at: now - 50,
      evidence: [],
    },
    {
      record_kind: "signal",
      signal_id: "sig-korean",
      offer_id: "offer-korean",
      canonical_product_id: "prd-korean-unknown",
      retailer_id: "shop-a",
      retailer_name: "Shop A",
      tcg: "pokemon",
      title: "Pokémon Moonlight S99 Korean Booster Box",
      observed_at: now - 40,
      evidence: [],
    },
    {
      record_kind: "signal",
      signal_id: "sig-celebrations",
      offer_id: "offer-celebrations",
      canonical_product_id: "prd-celebrations",
      retailer_id: "shop-c",
      retailer_name: "Shop C",
      tcg: "pokemon",
      title: "Pokémon Celebrations Elite Trainer Box (25th Anniversary)",
      observed_at: now - 30,
      evidence: [],
    },
    {
      record_kind: "signal",
      signal_id: "sig-conflict",
      offer_id: "offer-conflict",
      canonical_product_id: "prd-conflict",
      retailer_id: "shop-d",
      retailer_name: "Shop D",
      tcg: "pokemon",
      title: "Obsidian Flames Japanese Booster Pack",
      observed_at: now - 20,
      evidence: [],
    },
    {
      record_kind: "signal",
      signal_id: "sig-broad",
      offer_id: "offer-broad",
      canonical_product_id: "prd-broad",
      retailer_id: "shop-e",
      retailer_name: "Shop E",
      tcg: "pokemon",
      title: "Pokémon Mega Evolution Elite Trainer Box",
      observed_at: now - 10,
      evidence: [],
    },
    {
      record_kind: "signal",
      signal_id: "sig-identity-conflict",
      offer_id: "offer-identity-conflict",
      canonical_product_id: "prd-identity-conflict",
      retailer_id: "shop-f",
      retailer_name: "Shop F",
      tcg: "pokemon",
      title: "Pokémon TCG: Ascended Heroes Elite Trainer Box",
      observed_at: now - 5,
      facets: {
        languageGroup: "english",
        setKey: "pitch-black",
        setName: "Pitch Black",
        source: { language: "operator_verified", set: "operator_verified" },
        confidence: { language: 1, set: 1 },
        canonicalIdentity: {
          status: "conflict",
          kind: "conflict",
          source: "canonical_identity_conflict:pitch-black:ascended-heroes",
        },
      },
    },
  ]);

  assert.equal(audit.available, true);
  assert.equal(audit.mutationPolicy, "diagnostic_only_no_identity_promotion");
  assert.equal(audit.countUnit, "canonical_identity_groups");
  assert.equal(audit.totals.rowsEvaluated, 7);
  assert.equal(audit.totals.groupsAffected, 6);
  assert.equal(audit.totals.knownLanguageUnknownSet, 1);
  assert.equal(audit.totals.knownSetUnknownLanguage, 1);
  assert.equal(audit.totals.languageConflicts, 1);
  assert.equal(audit.totals.identityConflicts, 1);
  assert.equal(audit.totals.suspiciousBroadFamily, 1);
  assert.equal(audit.totals.unresolvedCanonicalIdentity, 2);

  const generic = audit.candidates.find((candidate) => candidate.canonicalProductId === "prd-generic");
  assert.ok(generic);
  assert.deepEqual(generic.retailers, ["Shop A", "Shop B"]);
  assert.equal(generic.signalsAffected, 1);
  assert.equal(generic.offersAffected, 2);
  assert.ok(generic.issues.includes("unknown_language_unknown_set"));
  assert.ok(generic.issues.includes("unresolved_canonical_identity"));

  const korean = audit.candidates.find((candidate) => candidate.canonicalProductId === "prd-korean-unknown");
  assert.deepEqual(korean.issues.sort(), ["known_language_unknown_set", "unknown_set", "unresolved_canonical_identity"].sort());
  assert.equal(korean.currentLanguage, "korean");

  const celebrations = audit.candidates.find((candidate) => candidate.canonicalProductId === "prd-celebrations");
  assert.ok(celebrations.issues.includes("known_set_unknown_language"));
  assert.equal(celebrations.currentSet.key, "celebrations");

  const conflict = audit.candidates.find((candidate) => candidate.canonicalProductId === "prd-conflict");
  assert.ok(conflict.issues.includes("language_conflict"));
  assert.match(conflict.languageSource, /^language_conflict:/);
  assert.match(conflict.conflictReason, /^language_conflict:/);

  const identityConflict = audit.candidates.find((candidate) => candidate.canonicalProductId === "prd-identity-conflict");
  assert.ok(identityConflict.issues.includes("identity_conflict"));
  assert.equal(identityConflict.conflictReason, "canonical_identity_conflict:pitch-black:ascended-heroes");
});

test("resolved non-set products are not falsely reported as unknown expansion holes", () => {
  const audit = buildIdentityFacetAudit([
    {
      record_kind: "offer",
      offer_id: "offer-deck",
      canonical_product_id: "prd-deck",
      retailer_name: "Shop A",
      tcg: "pokemon",
      title: "Pokémon TCG: Mega Lucario ex League Battle Deck",
      observed_at: 1_800_000_000,
      evidence: [],
    },
    {
      record_kind: "offer",
      offer_id: "offer-collection",
      canonical_product_id: "prd-collection",
      retailer_name: "Shop B",
      tcg: "pokemon",
      title: "Pokémon TCG: First Partner Illustration Collection - Series 2",
      observed_at: 1_800_000_001,
      evidence: [],
    },
  ]);

  assert.equal(audit.totals.unknownSet, 0);
  assert.equal(audit.totals.unresolvedCanonicalIdentity, 0);
  assert.equal(audit.totals.unknownLanguage, 2);
  for (const candidate of audit.candidates) {
    assert.deepEqual(candidate.issues, ["unknown_language"]);
    assert.equal(candidate.canonicalIdentity.status, "resolved");
  }
});

test("audit unavailability remains distinct from an empty healthy result", () => {
  const unavailable = buildIdentityFacetAudit(null);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.totals, null);

  const empty = buildIdentityFacetAudit([]);
  assert.equal(empty.available, true);
  assert.equal(empty.totals.rowsEvaluated, 0);
  assert.deepEqual(empty.candidates, []);
});
