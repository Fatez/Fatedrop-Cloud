import { rrpAliasSignature, shouldQueueUnresolvedRrp, unresolvedRrpRecord, rrpLearningId } from "./rrp-learning.mjs";
import { findVerifiedRrpAlias, recordUnresolvedRrp, recordVerifiedRrpAlias } from "../stores/rrp-learning-store.mjs";

export async function resolveRememberedRrpAlias({ store, product, offer } = {}) {
  if (!store?.pool) return null;
  const pool = await store.pool();
  const title = offer?.title || product?.title || "";
  const productType = offer?.productType || product?.productType || null;
  const tcg = product?.tcg || offer?.tcg || "pokemon";
  const aliasSignature = rrpAliasSignature({ tcg, title, productType });
  const alias = await findVerifiedRrpAlias(pool, { tcg, aliasSignature, productType });
  if (!alias) return null;
  return {
    rrpPence: Number(alias.official_rrp_pence),
    source: alias.rrp_source || "verified-alias-memory",
    observedAt: alias.rrp_verified_at ? Number(alias.rrp_verified_at) : null,
    kind: "official_rrp",
    basis: `Verified FateDrop alias for ${alias.canonical_title || "canonical product"}`,
    alias,
  };
}

export async function rememberUnresolvedRrp({ store, product, offer, retailer, observedAt, failureReason } = {}) {
  if (!store?.pool) return null;
  if (!shouldQueueUnresolvedRrp({
    title: offer?.title || product?.title,
    productType: offer?.productType || product?.productType,
    tcg: product?.tcg || offer?.tcg || "pokemon",
    language: offer?.language || product?.language,
    region: offer?.region || product?.region,
  })) return null;
  const row = unresolvedRrpRecord({ product, offer, retailer, failureReason, observedAt });
  return recordUnresolvedRrp(await store.pool(), row);
}

export async function rememberVerifiedRrpAlias({ store, product, offer, retailer, resolution, verifiedAt } = {}) {
  if (!store?.pool || !resolution?.canonicalProductIdentityId || !Number.isFinite(resolution?.confidence) || resolution.confidence < 0.99) return null;
  const title = offer?.title || product?.title || "";
  const productType = offer?.productType || product?.productType || null;
  const tcg = product?.tcg || offer?.tcg || "pokemon";
  const aliasSignature = rrpAliasSignature({ tcg, title, productType });
  return recordVerifiedRrpAlias(await store.pool(), {
    id: rrpLearningId("rrpa", aliasSignature),
    tcg,
    aliasSignature,
    observedTitle: title,
    productType,
    canonicalProductIdentityId: resolution.canonicalProductIdentityId,
    resolutionKind: resolution.resolutionKind || "verified_alias",
    confidence: resolution.confidence,
    source: resolution.source || "rrp-resolver",
    verifiedAt,
    retailerId: retailer?.id || offer?.retailerId || null,
    evidence: resolution.evidence || {},
  });
}
