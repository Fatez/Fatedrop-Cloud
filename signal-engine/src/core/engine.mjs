import { scanRetailerCatalogue } from "../adapters/catalogue-adapter.mjs";
import { env } from "../config/env.mjs";
import { deriveSignal } from "./signals.mjs";
import { isPurchasable } from "./model.mjs";
import { canonicalKey, normalizeWhitespace, productTypeFromTitle, stableId } from "./normalize.mjs";

function normalizeExternalProduct(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid ingested product");
  const title = normalizeWhitespace(raw.title);
  const retailerSku = normalizeWhitespace(raw.retailerSku || raw.sku);
  const url = normalizeWhitespace(raw.url);
  if (!title || !retailerSku || !url) throw new Error("Ingested products require title, retailerSku and url");
  const productType = raw.productType || productTypeFromTitle(title);
  return {
    retailerSku,
    title,
    url,
    imageUrl: raw.imageUrl || null,
    pricePence: Number.isFinite(raw.pricePence) ? Math.round(raw.pricePence) : null,
    productType,
    canonicalKey: raw.canonicalKey || canonicalKey(title, productType),
    stockStatus: raw.stockStatus || "unknown",
    stockConfidence: Number.isFinite(raw.stockConfidence) ? raw.stockConfidence : 0.5,
    stockQuantity: Number.isFinite(raw.stockQuantity) ? raw.stockQuantity : null,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [{ kind: "external_ingest", value: raw.evidence || "External collector observation" }],
  };
}

export async function processRetailerProducts({ retailer, store, rawProducts, now = Math.floor(Date.now() / 1000), pagesScanned = 0, source = "catalogue" }) {
  const baselineComplete = await store.isBaselineComplete(retailer.id);
  const quietBaseline = env.suppressBaselineSignals && !baselineComplete;
  const products = [];
  const offers = [];
  const observations = [];
  const signals = [];

  for (const rawInput of rawProducts) {
    const raw = source === "external" ? normalizeExternalProduct(rawInput) : rawInput;
    const productId = stableId("prd", raw.canonicalKey);
    const previousProduct = await store.getProduct(productId);
    const officialRrpPence = retailer.officialRrpSource && raw.pricePence != null ? raw.pricePence : previousProduct?.officialRrpPence ?? null;
    const product = {
      id: productId,
      canonicalKey: raw.canonicalKey,
      title: previousProduct?.title || raw.title,
      productType: raw.productType,
      tcg: "pokemon",
      officialRrpPence,
      rrpSource: retailer.officialRrpSource && raw.pricePence != null ? retailer.id : previousProduct?.rrpSource ?? null,
      rrpObservedAt: retailer.officialRrpSource && raw.pricePence != null ? now : previousProduct?.rrpObservedAt ?? null,
      firstSeenAt: previousProduct?.firstSeenAt ?? now,
      updatedAt: now,
    };
    const offerId = stableId("off", retailer.id, raw.retailerSku);
    const previousOffer = await store.getOffer(offerId);
    const everAvailableAt = previousOffer?.everAvailableAt ?? (isPurchasable(raw.stockStatus) ? now : null);
    const offer = {
      offerId,
      productId,
      productType: raw.productType,
      retailerId: retailer.id,
      retailerName: retailer.name,
      retailerSku: raw.retailerSku,
      title: raw.title,
      url: raw.url,
      imageUrl: raw.imageUrl,
      pricePence: raw.pricePence,
      rrpPence: officialRrpPence,
      postagePence: null,
      stockStatus: raw.stockStatus,
      stockConfidence: raw.stockConfidence,
      stockQuantity: raw.stockQuantity,
      evidence: raw.evidence,
      everAvailableAt,
      firstSeenAt: previousOffer?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    const observation = { id: stableId("obs", offerId, String(now), offer.stockStatus, String(offer.pricePence)), offerId, retailerId: retailer.id, observedAt: now, stockStatus: offer.stockStatus, stockConfidence: offer.stockConfidence, stockQuantity: offer.stockQuantity, pricePence: offer.pricePence, evidence: offer.evidence };
    const signal = deriveSignal({ previousOffer, currentOffer: offer, isBaseline: quietBaseline, now });
    products.push(product);
    offers.push(offer);
    observations.push(observation);
    if (signal) signals.push(signal);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  await store.saveScan({ retailer, products, offers, observations, signals, completedAt, health: { healthy: true, productsSeen: offers.length, pagesScanned, quietBaseline, source } });
  return { retailerId: retailer.id, retailerName: retailer.name, baseline: quietBaseline, pagesScanned, productsSeen: offers.length, signalsCreated: signals.length, signals };
}

export async function ingestRetailerProducts({ retailer, store, products, now = Math.floor(Date.now() / 1000) }) {
  if (!Array.isArray(products) || products.length === 0) throw new Error("products must be a non-empty array");
  if (products.length > 5000) throw new Error("Too many products in one ingest request");
  return processRetailerProducts({ retailer, store, rawProducts: products, now, pagesScanned: 0, source: "external" });
}

export async function scanRetailer({ retailer, store, now = Math.floor(Date.now() / 1000) }) {
  try {
    const { products: rawProducts, pages } = await scanRetailerCatalogue(retailer);
    return await processRetailerProducts({ retailer, store, rawProducts, now, pagesScanned: pages.length, source: "catalogue" });
  } catch (error) {
    await store.recordFailure(retailer, error, Math.floor(Date.now()/1000));
    return { retailerId: retailer.id, retailerName: retailer.name, error: String(error?.message || error), signalsCreated: 0 };
  }
}

export async function scanAll({ retailers, store }) {
  const results = [];
  for (let i = 0; i < retailers.length; i += env.scanConcurrency) {
    const batch = retailers.slice(i, i + env.scanConcurrency);
    results.push(...await Promise.all(batch.map((retailer) => scanRetailer({ retailer, store }))));
  }
  const measuredAt = Math.floor(Date.now() / 1000);
  if (store.recordNetworkSnapshot) {
    const [metrics, retailerHealth] = await Promise.all([store.stats(), store.listRetailers()]);
    await store.recordNetworkSnapshot({ id: stableId("net", String(measuredAt), String(metrics.offersTracked), String(metrics.signals24h)), measuredAt, metrics, retailers: retailerHealth });
  }
  return results;
}
