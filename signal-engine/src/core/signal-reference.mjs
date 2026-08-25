import { resolveInternationalMsrp } from "../rrp/international-msrp-authority.mjs";

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function evidence(kind, value, observedAt) {
  if (value == null || value === "") return null;
  return { kind, value: String(value), observedAt };
}

export function resolveSignalReference(currentOffer, observedAt = Math.floor(Date.now() / 1000)) {
  const existingRrp = finitePositive(currentOffer?.rrpPence);
  if (existingRrp !== null) {
    return {
      rrpPence: existingRrp,
      evidence: [],
      sourceMarket: false,
    };
  }

  const international = resolveInternationalMsrp({
    title: currentOffer?.title,
    productType: currentOffer?.productType,
    linkedProduct: currentOffer,
  });

  if (!international?.recognized || !international?.resolved || !finitePositive(international.rrpPence)) {
    return {
      rrpPence: null,
      evidence: [],
      sourceMarket: Boolean(international?.recognized),
    };
  }

  const referenceEvidence = [
    evidence("rrp_value_kind", international.kind, observedAt),
    evidence("rrp_value_source", international.rrpSource, observedAt),
    evidence("rrp_reference_basis", international.referenceBasis, observedAt),
    evidence("rrp_source_market", international.sourceMarket, observedAt),
    evidence("rrp_source_currency", international.sourceCurrency, observedAt),
    evidence("rrp_source_msrp", international.sourceMsrp, observedAt),
    evidence("rrp_source_unit_msrp", international.sourceUnitMsrp, observedAt),
    evidence("rrp_source_url", international.sourceUrl, observedAt),
    evidence("rrp_fx_observed_at", international.fxObservedAt, observedAt),
  ].filter(Boolean);

  return {
    rrpPence: international.rrpPence,
    evidence: referenceEvidence,
    sourceMarket: true,
  };
}
