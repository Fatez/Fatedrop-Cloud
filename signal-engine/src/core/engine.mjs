import { scanRetailerSource } from "../adapters/index.mjs";
import { env } from "../config/env.mjs";
import { dispatchDiscordSignals } from "../notifications/discord.mjs";
import { dispatchSignalDeliveryOutbox } from "../notifications/signal-outbox.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { createRetailerRunId, recordRetailerRunFinish, recordRetailerRunStart } from "../telemetry/retailer-runs.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";
import { resolveCanonicalRrp } from "./canonical-rrp-registry.mjs";
import { resolveRetailerDelivery } from "./delivery-policies.mjs";
import { buildRetailerPreparationClusters, preparationClusterEvidence } from "./preparation-cluster.mjs";
import { verifiedPurchasable } from "./preparation-intelligence.mjs";
import { deriveSignals } from "./signals.mjs";
import { canonicalKey, normalizeWhitespace, productTypeFromTitle, stableId } from "./normalize.mjs";
import { preloadPreviousState } from "./previous-state.mjs";
import { buildRrpValueContext, resolveRrpValue } from "./rrp-value-reference.mjs";
import { rememberUnresolvedRrp, rememberVerifiedRrpAlias, resolveRememberedRrpAlias } from "./rrp-learning-runtime.mjs";
import { deriveAlertFacets } from "./alert-facets.mjs";
import { applySignalBurstSafety } from "./signal-visibility-policy.mjs";
import { throwIfRetailerScanAborted } from "./scan-deadline.mjs";
import {
  authoritativeMarketClaims,
  explicitListingMarketClaims,
  marketResolutionEvidence,
  resolveCanonicalMarket,
} from "./market-memory-policy.mjs";
import {
  persistCanonicalMarketActions,
  preloadCanonicalMarketMemory,
  resolveCanonicalMarketIdentity,
} from "../stores/market-memory-store.mjs";
import {
  canEmitTcgLifecycleAlerts,
  canIngestTcgCatalogue,
  canMonitorTcgRetailers,
  requireKnownTcg,
} from "../trader/tcg-registry.mjs";

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
    language: raw.language || null,
    region: raw.region || null,
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
  if (typeof store?.pool === "function") {
    const outbox = await dispatchSignalDeliveryOutbox(store, { limit: Math.max(25, signals.length) });
    return {
      sent: outbox.sent,
      skipped: outbox.suppressed,
      failed: outbox.retryable + outbox.unknown + outbox.deadLetter,
      errors: outbox.errors,
      outbox,
    };
  }
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

async function loadRrpValueContext(store) {
  if (!store || typeof store.listProducts !== "function") return buildRrpValueContext([]);
  try {
    const products = await store.listProducts({ limit: 5000 });
    return buildRrpValueContext(products);
  } catch (error) {
    console.error("[rrp] value context preload failed", { error: String(error?.message || error) });
    return buildRrpValueContext([]);
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

function rrpEvidence(evidence, resolvedValue) {
  const base = Array.isArray(evidence) ? evidence : [];
  if (!resolvedValue?.resolved) return base;
  const extra = [];
  if (resolvedValue.kind) extra.push({ kind: "rrp_value_kind", value: String(resolvedValue.kind) });
  if (resolvedValue.rrpSource) extra.push({ kind: "rrp_value_source", value: String(resolvedValue.rrpSource) });
  if (resolvedValue.referenceBasis) extra.push({ kind: "rrp_reference_basis", value: String(resolvedValue.referenceBasis) });
  if (resolvedValue.sourceMarket) extra.push({ kind: "rrp_source_market", value: String(resolvedValue.sourceMarket) });
  if (resolvedValue.sourceCurrency) extra.push({ kind: "rrp_source_currency", value: String(resolvedValue.sourceCurrency) });
  if (resolvedValue.sourceMsrp != null) extra.push({ kind: "rrp_source_msrp", value: String(resolvedValue.sourceMsrp) });
  if (resolvedValue.learnedAlias === true) extra.push({ kind: "rrp_learning_disposition", value: "resolved_from_memory" });
  return [...base, ...extra];
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
      languageCode: existing.languageCode ?? product.languageCode,
      regionCode: existing.regionCode ?? product.regionCode,
      setName: existing.setName ?? product.setName,
      firstSeenAt: Math.min(existing.firstSeenAt ?? product.firstSeenAt, product.firstSeenAt ?? existing.firstSeenAt),
      updatedAt: Math.max(existing.updatedAt ?? 0, product.updatedAt ?? 0),
    });
  }
  return [...byId.values()];
}

const NON_STOCK_OBSERVATION_EVIDENCE = new Set([
  "alert_facets",
  "canonical_market_resolution",
]);

function evidenceKindSet(offer) {
  return new Set((Array.isArray(offer?.evidence) ? offer.evidence : [])
    .map((entry) => String(entry?.kind || "").trim())
    .filter((kind) => kind && !NON_STOCK_OBSERVATION_EVIDENCE.has(kind)));
}

function evidenceKindsChanged(previousOffer, currentOffer) {
  const previousKinds = evidenceKindSet(previousOffer);
  const currentKinds = evidenceKindSet(currentOffer);
  if (previousKinds.size !== currentKinds.size) return true;
  return [...previousKinds].some((kind) => !currentKinds.has(kind));
}

function shouldPersistObservation(previousOffer, currentOffer) {
  if (!previousOffer) return true;
  return previousOffer.stockStatus !== currentOffer.stockStatus
    || previousOffer.pricePence !== currentOffer.pricePence
    || previousOffer.stockQuantity !== currentOffer.stockQuantity
    || evidenceKindsChanged(previousOffer, currentOffer);
}

async function persistRrpLearningActions(store, actions) {
  let unknownsQueued = 0;
  let aliasesLearned = 0;
  for (const action of actions) {
    try {
      if (action.type === "unresolved") {
        const recorded = await rememberUnresolvedRrp(action.payload);
        if (recorded) unknownsQueued += 1;
      } else if (action.type === "verified_alias") {
        const recorded = await rememberVerifiedRrpAlias(action.payload);
        if (recorded) aliasesLearned += 1;
      }
    } catch (error) {
      console.error("[rrp-learning] persistence failed", {
        type: action.type,
        retailerId: action.payload?.retailer?.id,
        title: action.payload?.offer?.title,
        error: String(error?.message || error),
      });
    }
  }
  return { unknownsQueued, aliasesLearned };
}

async function persistMarketMemoryActions(store, actions, now) {
  try {
    return await persistCanonicalMarketActions(store, actions, now);
  } catch (error) {
    console.error("[market-memory] persistence failed", { error: String(error?.message || error) });
    return { observations: 0, memories: 0, conflicts: 0, unavailable: true };
  }
}

export async function processRetailerProducts({ retailer, store, rawProducts, now = Math.floor(Date.now() / 1000), pagesScanned = 0, source = "catalogue", dispatchNotifications = true }) {
  throwIfRetailerScanAborted();
  const tcgCode = requireKnownTcg(retailer.tcg || "pokemon").code;
  const baselineComplete = await store.isBaselineComplete(retailer.id);
  const quietBaseline = env.suppressBaselineSignals && !baselineComplete;
  const rrpContext = await loadRrpValueContext(store);
  const rrpRegistry = rrpContext.registry;
  const products = [];
  const offers = [];
  const observations = [];
  const signals = [];
  const rrpLearningActions = [];
  const marketMemoryActions = [];
  let rrpInherited = 0;
  let rrpResolvedFromMemory = 0;

  const prepared = rawProducts.map((rawInput) => {
    const raw = source === "external" ? normalizeExternalProduct(rawInput) : rawInput;
    return {
      raw,
      productId: stableId("prd", tcgCode, raw.canonicalKey),
      offerId: stableId("off", retailer.id, raw.retailerSku),
    };
  });

  const previousState = await preloadPreviousState(store, prepared);
  const marketMemoryContext = await preloadCanonicalMarketMemory({
    store,
    prepared,
    tcg: tcgCode,
  });
  const preparationClusters = buildRetailerPreparationClusters({
    retailerId: retailer.id,
    prepared,
    previousOffers: previousState?.offers ?? new Map(),
    now,
  });
  for (const item of prepared) {
    const cluster = preparationClusters.byOfferId.get(item.offerId);
    if (!cluster) continue;
    item.raw = {
      ...item.raw,
      evidence: [...(Array.isArray(item.raw.evidence) ? item.raw.evidence : []), ...preparationClusterEvidence(cluster)],
    };
  }

  for (const item of prepared) {
    throwIfRetailerScanAborted();
    const { raw, productId, offerId } = item;
    let marketIdentity = resolveCanonicalMarketIdentity(marketMemoryContext, item, tcgCode);
    const listingMarketClaims = explicitListingMarketClaims({ title: raw.title, region: raw.region });
    const preliminaryMarketResolution = resolveCanonicalMarket({
      remembered: marketIdentity.memory,
      listingClaims: listingMarketClaims,
    });
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
      tcg: tcgCode,
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

    const learningOffer = {
      offerId,
      productId,
      productType: raw.productType,
      retailerId: retailer.id,
      retailerSku: raw.retailerSku,
      title: raw.title,
      gtin: raw.gtin ?? null,
      language: raw.language,
      region: raw.region,
      tcg: tcgCode,
    };
    const rememberedAlias = preliminaryMarketResolution.status !== "conflict" && officialRrpPence == null
      ? await resolveRememberedRrpAlias({ store, product, offer: learningOffer })
      : null;
    if (rememberedAlias) rrpResolvedFromMemory += 1;

    const resolvedRrpValue = rememberedAlias
      ? {
        resolved: true,
        kind: rememberedAlias.kind || "official",
        rrpPence: rememberedAlias.rrpPence,
        rrpSource: rememberedAlias.source,
        rrpObservedAt: rememberedAlias.observedAt,
        unitCount: 1,
        unitKind: raw.productType || "product",
        unitRrpPence: rememberedAlias.rrpPence,
        referenceBasis: rememberedAlias.basis,
        matchedProductIds: rememberedAlias.alias?.canonical_product_identity_id ? [rememberedAlias.alias.canonical_product_identity_id] : [],
        learnedAlias: true,
      }
      : resolveRrpValue({
        title: raw.title,
        productType: raw.productType,
        tcg: retailer.tcg || "pokemon",
        language: raw.language,
        region: raw.region,
        edition: raw.edition,
        verifiedMarketCode: preliminaryMarketResolution.marketCode,
        marketResolutionStatus: preliminaryMarketResolution.status,
        linkedProduct: product,
      }, rrpContext);
    const matchedMarketIdentityIds = [...new Set((resolvedRrpValue.matchedProductIds || [])
      .filter((id) => id && !String(id).startsWith("external-reference:")))];
    if (matchedMarketIdentityIds.length === 1 && marketIdentity.resolutionKind === "current_canonical_key") {
      marketIdentity = {
        ...marketIdentity,
        productIdentityId: matchedMarketIdentityIds[0],
        resolutionKind: "verified_rrp_identity",
      };
    }
    const marketResolution = resolveCanonicalMarket({
      remembered: marketIdentity.memory,
      listingClaims: listingMarketClaims,
      authoritativeClaims: authoritativeMarketClaims({ rrpResolution: resolvedRrpValue, evidence: raw.evidence }),
    });
    const failClosedMarketRrp = marketResolution.status === "conflict"
      || (resolvedRrpValue.recognized === true && resolvedRrpValue.resolved !== true);
    const offerRrpPence = failClosedMarketRrp
      ? null
      : resolvedRrpValue.resolved ? resolvedRrpValue.rrpPence : officialRrpPence;
    const previousOffer = previousState
      ? previousState.offers.get(offerId) ?? null
      : await store.getOffer(offerId);
    const offerEvidence = [
      ...rrpEvidence(raw.evidence, resolvedRrpValue),
      ...marketResolutionEvidence(marketResolution, marketIdentity, now),
    ];
    const facets = deriveAlertFacets({
      title: raw.title,
      language: raw.language,
      region: raw.region,
      retailerCountryCode: retailer.countryCode || "GB",
      evidence: offerEvidence,
      marketResolution,
    });
    product.languageCode = facets.languageCode;
    product.regionCode = facets.marketCode || null;
    product.setName = facets.setName;
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
      rrpPence: offerRrpPence,
      postagePence: evidenceBackedPostage(raw, retailer),
      gtin: raw.gtin ?? null,
      stockStatus: raw.stockStatus,
      stockConfidence: raw.stockConfidence,
      stockQuantity: raw.stockQuantity,
      evidence: offerEvidence,
      language: raw.language || null,
      region: raw.region || null,
      retailerCountryCode: retailer.countryCode || "GB",
      facets,
      everAvailableAt: previousOffer?.everAvailableAt ?? null,
      firstSeenAt: previousOffer?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    marketMemoryActions.push({
      identity: marketIdentity,
      resolution: marketResolution,
      offerId,
      retailerId: retailer.id,
      title: raw.title,
      observedAt: now,
    });

    if (!resolvedRrpValue.resolved) {
      rrpLearningActions.push({
        type: "unresolved",
        payload: {
          store,
          product,
          offer: { ...learningOffer, ...offer, language: raw.language, region: raw.region },
          retailer,
          observedAt: now,
          failureReason: resolvedRrpValue.reason || "no_verified_rrp_reference",
        },
      });
    } else if (!rememberedAlias && resolvedRrpValue.kind === "official") {
      const matchedProductIds = [...new Set(resolvedRrpValue.matchedProductIds || [])];
      const canonicalProductIdentityId = matchedProductIds.length === 1 ? matchedProductIds[0] : null;
      if (canonicalProductIdentityId && canonicalProductIdentityId !== product.id) {
        rrpLearningActions.push({
          type: "verified_alias",
          payload: {
            store,
            product,
            offer: { ...learningOffer, ...offer },
            retailer,
            verifiedAt: now,
            resolution: {
              canonicalProductIdentityId,
              confidence: 1,
              resolutionKind: "verified_wording",
              source: resolvedRrpValue.rrpSource || "rrp-resolver",
              evidence: {
                reference_basis: resolvedRrpValue.referenceBasis || null,
                rrp_pence: resolvedRrpValue.rrpPence,
              },
            },
          },
        });
      }
    }

    if (!offer.everAvailableAt && verifiedPurchasable(offer)) offer.everAvailableAt = now;
    const observation = { id: stableId("obs", offerId, String(now), offer.stockStatus, String(offer.pricePence)), offerId, retailerId: retailer.id, observedAt: now, stockStatus: offer.stockStatus, stockConfidence: offer.stockConfidence, stockQuantity: offer.stockQuantity, pricePence: offer.pricePence, evidence: offer.evidence };
    const derivedSignals = canEmitTcgLifecycleAlerts(tcgCode)
      ? deriveSignals({ previousOffer, currentOffer: offer, isBaseline: quietBaseline, now })
      : [];
    products.push(product);
    offers.push(offer);
    if (shouldPersistObservation(previousOffer, offer)) observations.push(observation);
    if (derivedSignals.length) signals.push(...derivedSignals);
  }

  const burstSafety = applySignalBurstSafety(signals);
  signals.splice(0, signals.length, ...burstSafety.signals);
  const completedAt = Math.floor(Date.now() / 1000);
  const uniqueProducts = dedupeCanonicalProducts(products);
  throwIfRetailerScanAborted();
  const signalPersistence = await store.saveScan({ retailer, products: uniqueProducts, offers, observations, signals, completedAt, health: { healthy: true, productsSeen: offers.length, pagesScanned, quietBaseline, source } });
  const acceptedIds = Array.isArray(signalPersistence?.acceptedSignalIds)
    ? new Set(signalPersistence.acceptedSignalIds)
    : null;
  const canonicalSignals = acceptedIds ? signals.filter((signal) => acceptedIds.has(signal.id)) : signals;
  const rrpLearning = await persistRrpLearningActions(store, rrpLearningActions);
  const marketMemory = await persistMarketMemoryActions(store, marketMemoryActions, completedAt);

  const discord = dispatchNotifications ? await deliverSignals(store, canonicalSignals) : emptyDiscordResult({ deferred: canonicalSignals.length > 0 });
  return { retailerId: retailer.id, retailerName: retailer.name, baseline: quietBaseline, pagesScanned, productsSeen: offers.length, signalsCreated: canonicalSignals.length, signalConflicts: signalPersistence?.conflictSignalIds?.length || 0, preparationClusters: preparationClusters.clusters.length, rrpInherited, rrpResolvedFromMemory, rrpLearning, marketMemory, signalSafety: burstSafety.diagnostics, signals: canonicalSignals, discord };
}

export async function ingestRetailerProducts({ retailer, store, products, now = Math.floor(Date.now() / 1000) }) {
  if (!Array.isArray(products) || products.length === 0) throw new Error("products must be a non-empty array");
  if (products.length > 5000) throw new Error("Too many products in one ingest request");
  const tcgCode = requireKnownTcg(retailer.tcg || "pokemon").code;
  if (!canIngestTcgCatalogue(tcgCode)) {
    const error = new Error(`Catalogue ingestion is disabled for TCG: ${tcgCode}`);
    error.code = "tcg_catalogue_ingestion_disabled";
    throw error;
  }

  const runId = createRetailerRunId(retailer.id);
  const startedAt = Math.floor(Date.now() / 1000);
  await safeRunStart(store, { runId, retailerId: retailer.id, startedAt });
  const runIngest = () => processRetailerProducts({ retailer, store, rawProducts: products, now, pagesScanned: 0, source: "external" });

  try {
    let result;
    if (typeof store.withRetailerScanLock === "function") {
      const locked = await store.withRetailerScanLock(retailer.id, runIngest);
      result = locked.acquired ? locked.value : {
        retailerId: retailer.id,
        retailerName: retailer.name,
        skipped: true,
        skipReason: "ingest_in_progress",
        signalsCreated: 0,
      };
    } else {
      result = await runIngest();
    }

    const status = result?.skipped ? "skipped" : "success";
    await safeRunFinish(store, {
      runId,
      completedAt: Math.floor(Date.now() / 1000),
      status,
      pagesScanned: 0,
      productsObserved: result?.productsSeen ?? 0,
      catalogueComplete: status === "success",
      failureCode: result?.skipReason ?? null,
      diagnostics: { source: "external", signalsCreated: result?.signalsCreated ?? 0, rrpInherited: result?.rrpInherited ?? 0, rrpResolvedFromMemory: result?.rrpResolvedFromMemory ?? 0, rrpLearning: result?.rrpLearning ?? null },
    });
    return result;
  } catch (error) {
    if (typeof store.recordFailure === "function") await store.recordFailure(retailer, error, Math.floor(Date.now() / 1000));
    await safeRunFinish(store, {
      runId,
      completedAt: Math.floor(Date.now() / 1000),
      status: "failed",
      failureCode: error?.code || "external_ingest_exception",
      failureDetail: String(error?.message || error),
      diagnostics: { source: "external" },
    });
    throw error;
  }
}

export async function scanRetailer({ retailer, store, now = Math.floor(Date.now() / 1000), scanSource = scanRetailerSource, dispatchNotifications = true, runId: suppliedRunId = null }) {
  const tcgCode = requireKnownTcg(retailer.tcg || "pokemon").code;
  if (!canMonitorTcgRetailers(tcgCode)) {
    return {
      retailerId: retailer.id,
      retailerName: retailer.name,
      skipped: true,
      skipReason: "tcg_retailer_monitoring_disabled",
      tcgCode,
      signalsCreated: 0,
    };
  }
  if (retailer.adapterType === ADAPTER_TYPES.BROWSER_COLLECTOR) {
    return {
      retailerId: retailer.id,
      retailerName: retailer.name,
      skipped: true,
      skipReason: "external_collector",
      signalsCreated: 0,
    };
  }

  const runId = suppliedRunId || createRetailerRunId(retailer.id);
  const startedAt = Math.floor(Date.now() / 1000);
  await safeRunStart(store, { runId, retailerId: retailer.id, startedAt });

  const runScan = async () => {
    const scan = await scanSource(retailer);
    throwIfRetailerScanAborted();
    const rawProducts = scan?.products;
    const pages = Array.isArray(scan?.pages) ? scan.pages : [];
    const pagesScanned = pages.length;
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
      const error = new Error("Catalogue scan returned zero qualifying products; preserving last valid catalogue and marking retailer unhealthy.");
      error.code = "zero_qualifying_products";
      await store.recordFailure(retailer, error, Math.floor(Date.now() / 1000));
      return {
        retailerId: retailer.id,
        retailerName: retailer.name,
        error: error.message,
        failureCode: error.code,
        pagesScanned,
        productsSeen: 0,
        signalsCreated: 0,
      };
    }

    const result = await processRetailerProducts({ retailer, store, rawProducts, now, pagesScanned, source: "catalogue", dispatchNotifications });
    if (scan?.partialCatalogue === true) {
      const error = new Error("Catalogue discovery returned zero qualifying catalogue products; verified product probes were processed, but retailer remains unhealthy until full catalogue discovery is restored.");
      error.code = "partial_catalogue_discovery";
      await store.recordFailure(retailer, error, Math.floor(Date.now() / 1000));
      return { ...result, partialCatalogue: true, error: error.message, failureCode: error.code };
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
      failureCode: result?.skipReason || result?.failureCode || (result?.error ? "scan_failed" : null),
      failureDetail: result?.error || null,
      diagnostics: { signalsCreated: result?.signalsCreated ?? 0, rrpInherited: result?.rrpInherited ?? 0, rrpResolvedFromMemory: result?.rrpResolvedFromMemory ?? 0, rrpLearning: result?.rrpLearning ?? null },
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
