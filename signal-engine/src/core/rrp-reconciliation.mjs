import { compareProductIdentity } from "./product-identity.mjs";
import { evaluateRrpEvidence } from "./rrp-evidence.mjs";

function offerIdentityInput(offer = {}) {
  return {
    title: offer.title,
    productType: offer.productType,
    tcg: offer.tcg,
    language: offer.language,
    region: offer.region,
    edition: offer.edition,
    packCount: offer.packCount,
    caseQuantity: offer.caseQuantity,
    unitKind: offer.unitKind,
    formatVariant: offer.formatVariant,
    presentation: offer.presentation,
    identifiers: offer.identifiers,
  };
}

function evidenceIdentityInput(evidence = {}) {
  return {
    title: evidence.title,
    productType: evidence.productType,
    tcg: evidence.tcg,
    language: evidence.language,
    region: evidence.region,
    edition: evidence.edition,
    packCount: evidence.packCount,
    caseQuantity: evidence.caseQuantity,
    unitKind: evidence.unitKind,
    formatVariant: evidence.formatVariant,
    presentation: evidence.presentation,
    identifiers: evidence.identifiers,
  };
}

export function reconcileRrpEvidence(evidenceRecords = [], offers = []) {
  const comparisons = [];
  const rejectedEvidence = [];

  for (const [evidenceIndex, evidence] of evidenceRecords.entries()) {
    const policy = evaluateRrpEvidence(evidence);
    if (policy.decision === "reject") {
      rejectedEvidence.push({ evidenceIndex, evidence, policy });
      continue;
    }

    for (const [offerIndex, offer] of offers.entries()) {
      const identity = compareProductIdentity(
        evidenceIdentityInput(evidence),
        offerIdentityInput(offer),
      );

      comparisons.push({
        evidenceIndex,
        offerIndex,
        evidence,
        offer,
        policy,
        identity,
        outcome: identity.decision === "match"
          ? (policy.eligibleForOfficialRrp ? "safe_rrp_match" : "reference_only_match")
          : identity.decision,
      });
    }
  }

  const safeMatches = comparisons.filter((row) => row.outcome === "safe_rrp_match");
  const referenceOnlyMatches = comparisons.filter((row) => row.outcome === "reference_only_match");
  const ambiguous = comparisons.filter((row) => row.outcome === "ambiguous");
  const rejectedMatches = comparisons.filter((row) => row.outcome === "reject");

  const grouped = new Map();
  for (const row of safeMatches) {
    const productId = row.offer.productId;
    if (!productId) continue;
    if (!grouped.has(productId)) grouped.set(productId, []);
    grouped.get(productId).push(row);
  }

  const assignments = [];
  const conflicts = [];
  for (const [productId, rows] of grouped.entries()) {
    const prices = [...new Set(rows.map((row) => row.policy.officialRrpPence))];
    if (prices.length !== 1) {
      conflicts.push({
        productId,
        prices,
        reason: "conflicting_authoritative_rrp_evidence",
        evidence: rows.map((row) => ({
          title: row.evidence.title,
          sourceUrl: row.policy.normalized.sourceUrl,
          pricePence: row.policy.officialRrpPence,
        })),
      });
      continue;
    }

    assignments.push({
      productId,
      title: rows[0].offer.title,
      officialRrpPence: prices[0],
      sources: rows.map((row) => ({
        sourceRole: row.policy.normalized.sourceRole,
        priceKind: row.policy.normalized.priceKind,
        sourceName: row.policy.normalized.sourceName,
        sourceUrl: row.policy.normalized.sourceUrl,
        observedAt: row.policy.normalized.observedAt,
      })),
      dryRunOnly: true,
    });
  }

  return {
    summary: {
      evidenceRecords: evidenceRecords.length,
      offers: offers.length,
      rejectedEvidence: rejectedEvidence.length,
      safeMatches: safeMatches.length,
      referenceOnlyMatches: referenceOnlyMatches.length,
      ambiguous: ambiguous.length,
      rejectedMatches: rejectedMatches.length,
      proposedAssignments: assignments.length,
      conflicts: conflicts.length,
    },
    assignments,
    conflicts,
    rejectedEvidence,
    comparisons,
  };
}
