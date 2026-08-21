export const PublicAlertType = Object.freeze({
  ECHO: "echo",
  MANIFESTED: "manifested",
  VANISHED: "vanished",
});

export function publicAlertType(signalOrState) {
  const state = typeof signalOrState === "string" ? signalOrState : signalOrState?.state;
  if (state === "whisper") return PublicAlertType.ECHO;
  if (state === "manifested" || state === "echo") return PublicAlertType.MANIFESTED;
  if (state === "vanished") return PublicAlertType.VANISHED;
  return null;
}

export function toPublicAlert(signal) {
  if (!signal) return null;
  const type = publicAlertType(signal);
  if (!type) return null;

  const targetKind = type === PublicAlertType.MANIFESTED && signal.offerId ? "offer" : "product";
  return {
    id: signal.id,
    type,
    internalState: signal.state,
    productId: signal.productId ?? null,
    offerId: signal.offerId ?? null,
    retailerId: signal.retailerId ?? null,
    retailerName: signal.retailerName ?? null,
    title: signal.title ?? null,
    productType: signal.productType ?? null,
    imageUrl: signal.imageUrl ?? null,
    pricePence: Number.isFinite(signal.pricePence) ? signal.pricePence : null,
    rrpPence: Number.isFinite(signal.rrpPence) ? signal.rrpPence : null,
    markupPercent: Number.isFinite(signal.markupPercent) ? signal.markupPercent : null,
    stockStatus: signal.stockStatus ?? null,
    confidence: Number.isFinite(signal.confidence) ? signal.confidence : null,
    detectedAt: signal.detectedAt ?? null,
    reason: signal.reason ?? null,
    target: {
      kind: targetKind,
      productId: signal.productId ?? null,
      offerId: targetKind === "offer" ? signal.offerId ?? null : null,
      retailerId: targetKind === "offer" ? signal.retailerId ?? null : null,
      retailerUrl: targetKind === "offer" ? signal.url ?? null : null,
      query: signal.title ?? null,
    },
  };
}
