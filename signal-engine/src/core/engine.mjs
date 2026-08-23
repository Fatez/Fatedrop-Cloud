import { scanRetailerSource } from "../adapters/index.mjs";
import { env } from "../config/env.mjs";
import { dispatchDiscordSignals } from "../notifications/discord.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { createRetailerRunId, recordRetailerRunFinish, recordRetailerRunStart } from "../telemetry/retailer-runs.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";
import { buildCanonicalRrpRegistry, resolveCanonicalRrp } from "./canonical-rrp-registry.mjs";
import { resolveRetailerDelivery } from "./delivery-policies.mjs";
import { deriveSignal } from "./signals.mjs";
import { isPurchasable } from "./model.mjs";
import { canonicalKey, normalizeWhitespace, productTypeFromTitle, stableId } from "./normalize.mjs";
import { preloadPreviousState } from "./previous-state.mjs";

function normalizeExternalProduct(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid ingested product");
  const title = normalizeWhitespace(raw.title);
  const retailerSku = normalizeWhitespace(raw.retailerSku || raw.sku);
  const url = normalizeWhitespace(raw.url);
  if (!title || !retailerSku || !url) throw new Error("Ingested products require title, retailerSku and url");
  const productType = raw.productType || productTypeFromTitle(title);
  const gtin = normalizeWhitespace(raw.gtin || raw.barcode) || null;
  return {
    retailerSku,
    title,
    url,
    imageUrl: raw.imageUrl || null,
    pricePence: Number.isFinite(raw.pricePence) ? Math.round(raw.pricePence) : null,
    postagePence: Number.isFinite(raw.postagePence) && raw.postagePence >= 0 ? Math.round(raw.postagePence) : null,
    officialRrpPence: Number.isFinite(raw.officialRrpPence) ? Math.round(raw.officialRrpPence) : null,
    gtin,
    productType,
    canonicalKey: raw.canonicalKey || canonicalKey(title, productType),
    stockStatus: raw.stockStatus || "unknown",
    stockConfidence: Number.isFinite(raw.stockConfidence) ? raw.stockConfidence : 0.5,
    stockQuantity: Number.isFinite(raw.stockQuantity) ? raw.stockQuantity : null,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [{ kind: "external_ingest", value: raw.evidence || "External collector observation" }],
  };
}

function evidenceBackedPostage(raw, retailer) {
  if (Number.isFinite(raw.postagePence) && raw.postagePence >= 0) return Math.round(raw.postagePence);
  const resolved = resolveRetailerDelivery({ retailerId: retailer?.id, subtotalPence: raw.pricePence });
  if (resolved.known) return resolved.postagePence;
  if (retailer?.delivery?.known === true && Number.isFinite(retailer.delivery.standardPence) && retailer.delivery.standardPence >= 0) return Math.round(retailer.delivery.standardPence);
  return null;
}

function emptyDiscordResult(extra = {}) { return { sent: 0, skipped: 0, failed: 0, errors: [], ...extra }; }

async function deliverSignals(store, signals) {
  if (!signals.length) return emptyDiscordResult();
  return dispatchDiscordSignals(signals, {
    onDeliveryAttempt: (attempt) => recordSignalDeliveryAttempt(store, attempt),
  });
}

async function safeRunStart(store, payload) {
  try { await recordRetailerRunStart(store, payload); }
  catch (error) { console.error("[monitor] run-start telemetry failed", { retailerId: payload.retailerId, error: String(error?.message || error) }); }
}

async function safeRunFinish(store, payload) {
  try { await recordRetailerRunFinish(store, payload); }
  catch (error) { console.error("[monitor] run-finish telemetry failed", { runId: payload.runId, error: String(error?.message || error) }); }
}

async function loadCanonicalRrpRegistry(store) {
  if (!store || typeof store.listProducts !== "function") return buildCanonicalRrpRegistry([]);
  try {
    const products = await store.listProducts({ limit: 5000 });
    return buildCanonicalRrpRegistry(products);
  } catch (error) {
    console.error("[rrp] canonical registry preload failed", { error: String(error?.message || error) });
    return buildCanonicalRrpRegistry([]);
  }
}

function productIdentityForRrp(raw, retailer) {
  return {
    title: raw.title,
    productType: raw.productType,
    tcg: retailer.tcg || "pokemon",
    language: raw.language,
    region: raw.region,
    edition: raw.edition,
    packCount: raw.packCount,
    caseQuantity: raw.caseQuantity,
    unitKind: raw.unitKind,
    formatVariant: raw.formatVariant,
    presentation: raw.presentation,
    identifiers: raw.gtin ? { ...(raw.identifiers || {}), gtin: raw.gtin } : raw.identifiers,
  };
}

function validRrp(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function dedupeCanonicalProducts(products) {
  const byId = new Map();
  for (const product of products) {
    const existing = byId.get(product.id);
    if (!existing) {
      byId.set(product.id, product);
      continue;
    }
    byId.set(product.id, {
      ...existing,
      title: existing.title || product.title,
      productType: existing.productType || product.productType,
      officialRrpPence: existing.officialRrpPence ?? product.officialRrpPence,
      rrpSource: existing.rrpSource ?? product.rrpSource,
      rrpObservedAt: existing.rrpObservedAt ?? product.rrpObservedAt,
      firstSeenAt: Math.min(existing.firstSeenAt ?? product.firstSeenAt, product.firstSeenAt ?? existing.firstSeenAt),
      updatedAt: Math.max(existing.updatedAt ?? 0, product.updatedAt ?? 0),
    });
  }
  return [...byId.values()];
}

function shouldPersistObservation(previousOffer, currentOffer) {
  if (!previousOffer) return true;
  return previousOffer.stockStatus !== currentOffer.stockStatus
    || previousOffer.pricePence !== currentOffer.pricePence
    || previousOffer.stockQuantity !== currentOffer.stockQuantity;
}

export async function processRetailerProducts({ retailer, store, rawProducts, now = Math.floor(Date.now() / 1000), pagesScanned = 0, source = "catalogue", dispatchNotifications = true }) {
  const baselineComplete = await store.isBaselineComplete(retailer.id);
  const quietBaseline = env.suppressBaselineSignals && !baselineComplete;
  const rrpRegistry = await loadCanonicalRrpRegistry(store);
  const products = [];
  const offers = [];
  const observations = [];
  const signals = [];
  let rrpInherited = 0;

  const prepared = rawProducts.map((rawInput) => {
    const raw = source === "external" ? normalizeExternalProduct(rawInput) : rawInput;
    return {
      raw,
      productId: stableId("prd", retailer.tcg || "pokemon", raw.canonicalKey),
      offerId: stableId("off", retailer.id, raw.retailerSku),
    };
  });

  const previousState = await preloadPreviousState(store, prepared);

  for (const item of prepared) {
    const { raw, productId, offerId } = item;
    const previousProduct = previousState
      ? previousState.products.get(productId) ?? null
      : await store.getProduct(productId);
    const explicitOfficialRrp = validRrp(raw.officialRrpPence);
    const hasFreshOfficialRrp = Boolean(retailer.officialRrpSource && explicitOfficialRrp != null);
    const previousOfficialRrp = validRrp(previousProduct?.officialRrpPence);
    const inheritedRrp = !hasFreshOfficialRrp && previousOfficialRrp == null
      ? resolveCanonicalRrp(productIdentityForRrp(raw, retailer), rrpRegistry)
      : { resolved: false };
    if (inheritedRrp.resolved) rrpInherited += 1;
    const officialRrpPence = hasFreshOfficialRrp
      ? explicitOfficialRrp
      : previousOfficialRrp ?? (inheritedRrp.resolved ? inheritedRrp.officialRrpPence : null);
    const product = {
      id: productId,
      canonicalKey: raw.canonicalKey,
      title: previousProduct?.title || raw.title,
      productType: raw.productType,
      tcg: retailer.tcg || "pokemon",
      officialRrpPence,
      rrpSource: hasFreshOfficialRrp
        ? retailer.id
        : previousProduct?.rrpSource ?? (inheritedRrp.resolved ? inheritedRrp.rrpSource : null),
      rrpObservedAt: hasFreshOfficialRrp
        ? now
        : previousProduct?.rrpObservedAt ?? (inheritedRrp.resolved ? inheritedRrp.rrpObservedAt : null),
      firstSeenAt: previousProduct?.firstSeenAt ?? now,
      updatedAt: now,
    };
    const previousOffer = previousState
      ? previousState.offers.get(offerId) ?? null
      : await store.getOffer(offerId);
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
      postagePence: evidenceBackedPostage(raw, retailer),
      gtin: raw.gtin ?? null,
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
    if (shouldPersistObservation(previousOffer, offer)) observations.push(observation);
    if (signal) signals.push(signal);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const uniqueProducts = dedupeCanonicalProducts(products);
  await store.saveScan({ retailer, products: uniqueProducts, offers, observations, signals, completedAt, health: { healthy: true, productsSeen: offers.length, pagesScanned, quietBaseline, source } });

  const discord = dispatchNotifications ? await deliverSignals(store, signals) : emptyDiscordResult({ deferred: signals.length > 0 });
  return { retailerId: retailer.id, retailerName: retailer.name, baseline: quietBaseline, pagesScanned, productsSeen: offers.length, signalsCreated: signals.length, rrpInherited, signals, discord };
}

export async function ingestRetailerProducts({ retailer, store, products, now = Math.floor(Date.now() / 1000) }) {
  if (!Array.isArray(products) || products.length === 0) throw new Error("products must be a non-empty array");
  if (products.length > 5000) throw new Error("Too many products in one ingest request");
  return processRetailerProducts({ retailer, store, rawProducts: products, now, pagesScanned: 0, source: "external" });
}

export async function scanRetailer({ retailer, store, now = Math.floor(Date.now() / 1000), scanSource = scanRetailerSource, dispatchNotifications = true }) {
  if (retailer.adapterType === ADAPTER_TYPES.BROWSER_COLLECTOR) {
    return {
      retailerId: retailer.id,
      retailerName: retailer.name,
      skipped: true,
      skipReason: "external_collector",
      signalsCreated: 0,
    };
  }

  const runId = createRetailerRunId(retailer.id);
  const startedAt = Math.floor(Date.now() / 1000);
  await safeRunStart(store, { runId, retailerId: retailer.id, startedAt });

  const runScan = async () => {
    const scan = await scanSource(retailer);
    const rawProducts = scan?.products;
    const pages = Array.isArray(scan?.pages) ? scan.pages : [];
    const pagesScanned = pages.length;
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
      const error = new Error("Catalogue scan returned zero qualifying products; preserving last valid catalogue and marking retailer unhealthy.");
      await store.recordFailure(retailer, error, Math.floor(Date.now() / 1000));
      return {
        retailerId: retailer.id,
        retailerName: retailer.name,
        error: error.message,
        pagesScanned,
        productsSeen: 0,
        signalsCreated: 0,
      };
    }

    const result = await processRetailerProducts({ retailer, store, rawProducts, now, pagesScanned, source: "catalogue", dispatchNotifications });
    if (scan?.partialCatalogue === true) {
      const error = new Error("Catalogue discovery returned zero qualifying catalogue products; verified product probes were processed, but retailer remains unhealthy until full catalogue discovery is restored.");
      await store.recordFailure(retailer, error, Math.floor(Date.now() / 1000));
      return { ...result, partialCatalogue: true, error: error.message };
    }
    return result;
  };

  try {
    let result;
    if (typeof store.withRetailerScanLock === "function") {
      const locked = await store.withRetailerScanLock(retailer.id, runScan);
      if (!locked.acquired) {
        result = {
          retailerId: retailer.id,
          retailerName: retailer.name,
          skipped: true,
          skipReason: "scan_in_progress",
          signalsCreated: 0,
        };
      } else {
        result = locked.value;
      }
    } else {
      result = await runScan();
    }

    const status = result?.skipped ? "skipped" : result?.error ? (result.partialCatalogue ? "partial" : "failed") : "success";
    await safeRunFinish(store, {
      runId,
      completedAt: Math.floor(Date.now() / 1000),
      status,
      pagesScanned: result?.pagesScanned ?? 0,
      productsObserved: result?.productsSeen ?? 0,
      catalogueComplete: status === "success",
      failureCode: result?.skipReason || (result?.error ? "scan_failed" : null),
      failureDetail: result?.error || null,
      diagnostics: { signalsCreated: result?.signalsCreated ?? 0, rrpInherited: result?.rrpInherited ?? 0 },
    });
    return result;
  } catch (error) {
    await store.recordFailure(retailer, error, Math.floor(Date.now()/1000));
    const detail = String(error?.message || error);
    await safeRunFinish(store, {
      runId,
      completedAt: Math.floor(Date.now() / 1000),
      status: "failed",
      failureCode: error?.code || "scan_exception",
      failureDetail: detail,
    });
    return { retailerId: retailer.id, retailerName: retailer.name, error: detail, signalsCreated: 0 };
  }
}

export async function scanAll({ retailers, store, scanRetailerFn = scanRetailer }) {
  const results = new Array(retailers.length);
  const deliveryTasks = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= retailers.length) return;

      const retailer = retailers[index];
      const result = await scanRetailerFn({ retailer, store, dispatchNotifications: false });
      results[index] = result;

      if (Array.isArray(result?.signals) && result.signals.length > 0) {
        const deliveryTask = deliverSignals(store, result.signals)
          .then((discord) => { result.discord = discord; })
          .catch((error) => {
            result.discord = { sent: 0, skipped: 0, failed: result.signals.length, errors: [{ error: String(error?.message || error) }] };
          });
        deliveryTasks.push(deliveryTask);
      }
    }
  }

  const workerCount = Math.min(Math.max(1, env.scanConcurrency), Math.max(1, retailers.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  await Promise.all(deliveryTasks);

  const measuredAt = Math.floor(Date.now() / 1000);
  if (store.recordNetworkSnapshot) {
    const [metrics, retailerHealth] = await Promise.all([store.stats(), store.listRetailers()]);
    const observedMetrics = {
      ...metrics,
      scheduledRetailerCount: retailers.length,
      scheduledRetailerIds: retailers.map((retailer) => retailer.id),
    };
    await store.recordNetworkSnapshot({ id: stableId("net", String(measuredAt), String(metrics.offersTracked), String(metrics.signals24h)), measuredAt, metrics: observedMetrics, retailers: retailerHealth });
  }
  return results;
}
