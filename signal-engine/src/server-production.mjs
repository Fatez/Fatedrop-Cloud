import { env } from "./config/env.mjs";
import { runAsdaBranchDensitySync } from "./encounters/asda-branch-density-sync.mjs";
import { reconcileCuratedIncomingIntel } from "./encounters/curated-incoming-intel-reconcile.mjs";
import { ensureCuratedNetworkRetailerBranchSeeds } from "./encounters/curated-network-retailer-branch-seeds.mjs";
import { ensureCuratedRetailerBranchSeeds } from "./encounters/curated-retailer-branch-seeds.mjs";
import { runCuratedRetailerBranchSync } from "./encounters/curated-retailer-branch-sync.mjs";
import { runNationalBranchDirectorySync } from "./encounters/national-branch-directory-sync.mjs";
import { startOperatorLocalRadarIntake } from "./encounters/operator-local-radar-intake.mjs";
import { runOsmRetailerBranchSync } from "./encounters/osm-retailer-branch-sync.mjs";
import { monitorRetailerIntelligenceSurface } from "./encounters/retailer-intelligence-monitor.mjs";
import { reconcileTotalCardsPhysicalAvailability } from "./encounters/total-cards-local-availability.mjs";
import "./notifications/lifecycle-push-heartbeat.mjs";
import { runCandidateQualificationCycle } from "./retailers/candidate-qualification.mjs";
import { createStore } from "./stores/index.mjs";
import { runCardmarketPokemonMarketCycle } from "./trader/value/cardmarket-market-cycle.mjs";
import "./server.mjs";

const RETAILER_QUALIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETAILER_QUALIFICATION_START_DELAY_MS = 10 * 1000;
const CURATED_BRANCH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CURATED_BRANCH_SYNC_START_DELAY_MS = 15 * 1000;
const LOCAL_BRANCH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_BRANCH_SYNC_START_DELAY_MS = 20 * 1000;
const OSM_BRANCH_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OSM_BRANCH_SYNC_START_DELAY_MS = 45 * 1000;
const CURATED_LOCAL_INTEL_INTERVAL_MS = 30 * 60 * 1000;
const CURATED_LOCAL_INTEL_START_DELAY_MS = 90 * 1000;
const TOTAL_CARDS_LOCAL_INTERVAL_MS = 5 * 60 * 1000;
const TOTAL_CARDS_LOCAL_START_DELAY_MS = 120 * 1000;
const ASDA_DENSITY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ASDA_DENSITY_START_DELAY_MS = 180 * 1000;
const CARDMARKET_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CARDMARKET_DAILY_START_DELAY_MS = 5 * 60 * 1000;
const RETAILER_INTELLIGENCE_START_DELAY_MS = 2 * 60 * 1000;
const localBranchStore = createStore();
startOperatorLocalRadarIntake({ store: localBranchStore });
let qualifyingRetailerCandidates = false;
let syncingCuratedBranches = false;
let syncingLocalBranches = false;
let syncingOsmBranches = false;
let reconcilingCuratedLocalIntel = false;
let reconcilingTotalCardsLocal = false;
let syncingAsdaDensity = false;
let syncingCardmarketDaily = false;
let monitoringRetailerIntelligence = false;

async function qualifyRetailerCandidates() {
  if (qualifyingRetailerCandidates || !env.databaseUrl) return;
  qualifyingRetailerCandidates = true;
  try {
    const outcome = await runCandidateQualificationCycle({ databaseUrl: env.databaseUrl, store: localBranchStore });
    console.log("[signal-engine] retailer candidate qualification", {
      candidates: outcome.candidates,
      due: outcome.due,
      attempted: outcome.attempted,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      retailers: outcome.results.map((row) => ({
        retailer: row.retailerId,
        ok: row.ok,
        products: row.diagnostics?.productsObserved ?? 0,
        priceCoverage: row.diagnostics?.priceCoverage ?? null,
        stockCoverage: row.diagnostics?.stockCoverage ?? null,
        likelyPokemonSealed: row.diagnostics?.relevance?.likelyPokemonSealed ?? 0,
        error: row.error || null,
      })),
    });
  } catch (error) {
    console.error("[signal-engine] retailer candidate qualification failed", { error: String(error?.message || error) });
  } finally {
    qualifyingRetailerCandidates = false;
  }
}

async function syncCuratedRetailerBranches() {
  if (syncingCuratedBranches || !env.databaseUrl) return;
  syncingCuratedBranches = true;
  try {
    const outcome = await runCuratedRetailerBranchSync({ store: localBranchStore });
    const networkOutcome = await ensureCuratedNetworkRetailerBranchSeeds({ store: localBranchStore });
    console.log("[signal-engine] Local Radar manual branch seed sync", {
      provider: outcome.provider,
      status: outcome.status,
      configured: outcome.configured,
      accepted: outcome.accepted,
      saved: outcome.saved,
      inserted: outcome.inserted,
      updated: outcome.updated,
      rejected: outcome.rejected.length,
    });
    console.log("[signal-engine] Local Radar official specialist branch seed sync", {
      status: networkOutcome.status,
      configured: networkOutcome.configured,
      alreadyKnown: networkOutcome.alreadyKnown,
      attempted: networkOutcome.attempted,
      accepted: networkOutcome.accepted,
      saved: networkOutcome.saved,
      rejected: networkOutcome.rejected.length,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar manual branch seed sync failed", { error: String(error?.message || error) });
  } finally {
    syncingCuratedBranches = false;
  }
}

async function syncLocalRetailerBranches() {
  if (syncingLocalBranches || !env.databaseUrl) return;
  syncingLocalBranches = true;
  try {
    const outcome = await runNationalBranchDirectorySync({ store: localBranchStore, branchFetchLimit: 250 });
    console.log("[signal-engine] Local Radar national branch directory sync", {
      status: outcome.status,
      discovered: outcome.discovered,
      alreadyKnown: outcome.alreadyKnown,
      attempted: outcome.attempted,
      accepted: outcome.accepted,
      saved: outcome.saved,
      rejected: outcome.rejected,
      sources: outcome.sources,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar national branch directory sync failed", { error: String(error?.message || error) });
  } finally {
    syncingLocalBranches = false;
  }
}

async function syncOsmRetailerBranches() {
  if (syncingOsmBranches || !env.databaseUrl) return;
  syncingOsmBranches = true;
  try {
    const outcome = await runOsmRetailerBranchSync({ store: localBranchStore, saveLimit: 750 });
    console.log("[signal-engine] Local Radar geographic branch fallback", {
      provider: outcome.provider,
      status: outcome.status,
      discovered: outcome.discovered,
      accepted: outcome.accepted,
      alreadyKnown: outcome.alreadyKnown,
      attempted: outcome.attempted,
      deferred: outcome.deferred,
      saved: outcome.saved,
      rejected: outcome.rejected,
      countsByRetailer: outcome.countsByRetailer,
      error: outcome.error || null,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar geographic branch fallback failed", { error: String(error?.message || error) });
  } finally {
    syncingOsmBranches = false;
  }
}

async function reconcileCuratedLocalIntel() {
  if (reconcilingCuratedLocalIntel || !env.databaseUrl) return;
  reconcilingCuratedLocalIntel = true;
  try {
    const branches = await ensureCuratedRetailerBranchSeeds({ store: localBranchStore });
    const outcome = await reconcileCuratedIncomingIntel({ store: localBranchStore });
    console.log("[signal-engine] Local Radar curated expected-stock reconciliation", {
      status: outcome.status,
      branchSeedsConfigured: branches.configured,
      branchSeedsAlreadyKnown: branches.alreadyKnown,
      branchSeedsSaved: branches.saved,
      branchSeedsRejected: branches.rejected.length,
      configuredEntries: outcome.configuredEntries,
      activeEntries: outcome.activeEntries,
      matchedBranches: outcome.matchedBranches,
      saved: outcome.saved,
      duplicates: outcome.duplicates,
      rejected: outcome.rejected.length,
      unmatchedTargets: outcome.unmatchedTargets.length,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar curated expected-stock reconciliation failed", { error: String(error?.message || error) });
  } finally {
    reconcilingCuratedLocalIntel = false;
  }
}

async function reconcileTotalCardsLocal() {
  if (reconcilingTotalCardsLocal || !env.databaseUrl) return;
  reconcilingTotalCardsLocal = true;
  try {
    const outcome = await reconcileTotalCardsPhysicalAvailability({ store: localBranchStore });
    console.log("[signal-engine] Local Radar Total Cards physical availability", {
      status: outcome.status,
      branchSaved: outcome.branchSaved,
      branchId: outcome.branchId || null,
      checked: outcome.checked,
      accepted: outcome.accepted || 0,
      saved: outcome.saved,
      duplicates: outcome.duplicates,
      rejected: outcome.rejected?.length || 0,
      results: outcome.results || [],
      error: outcome.error || null,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar Total Cards physical availability failed", { error: String(error?.message || error) });
  } finally {
    reconcilingTotalCardsLocal = false;
  }
}

async function syncAsdaDensity() {
  if (syncingAsdaDensity || !env.databaseUrl) return;
  syncingAsdaDensity = true;
  try {
    const outcome = await runAsdaBranchDensitySync({ store: localBranchStore, limit: 600, concurrency: 8 });
    console.log("[signal-engine] Local Radar ASDA density sync", {
      provider: outcome.provider,
      status: outcome.status,
      discovered: outcome.discovered,
      alreadyKnown: outcome.alreadyKnown,
      attempted: outcome.attempted,
      accepted: outcome.accepted,
      saved: outcome.saved,
      rejected: outcome.rejected,
      concurrency: outcome.concurrency,
      error: outcome.error || null,
    });
  } catch (error) {
    console.error("[signal-engine] Local Radar ASDA density sync failed", { error: String(error?.message || error) });
  } finally {
    syncingAsdaDensity = false;
  }
}

async function syncCardmarketDailyPrices() {
  if (syncingCardmarketDaily || !env.databaseUrl) return;
  syncingCardmarketDaily = true;
  try {
    const outcome = await runCardmarketPokemonMarketCycle({ store: localBranchStore, mode: 'persist' });
    console.log("[signal-engine] FatePrice Cardmarket daily market cycle", {
      status: outcome.status,
      sourceEffectiveAt: outcome.sourceEffectiveAt,
      mappedProducts: outcome.mappedProducts,
      scopedPriceGuideRows: outcome.scopedPriceGuideRows,
      recordsSeen: outcome.recordsSeen,
      recordsAccepted: outcome.recordsAccepted,
      recordsRejected: outcome.recordsRejected,
      insertedObservations: outcome.persistence?.insertedObservations ?? 0,
      duplicateObservations: outcome.persistence?.duplicateObservations ?? 0,
    });
  } catch (error) {
    console.error("[signal-engine] FatePrice Cardmarket daily market cycle failed", { error: String(error?.message || error) });
  } finally {
    syncingCardmarketDaily = false;
  }
}

async function monitorRetailerIntelligence() {
  if (monitoringRetailerIntelligence || !env.databaseUrl || !env.encounters.retailerIntelligenceEnabled) return;
  monitoringRetailerIntelligence = true;
  try {
    const outcome = await monitorRetailerIntelligenceSurface({ store: localBranchStore });
    console.log("[signal-engine] retailer intelligence surface", {
      surfaceId: outcome.surfaceId,
      status: outcome.status,
      products: outcome.products,
      matchedBranches: outcome.matchedBranches || 0,
      unmatchedTargets: outcome.unmatchedTargets || 0,
      notificationsPublished: outcome.notificationsPublished || 0,
      notificationsHeld: outcome.notificationsHeld || 0,
    });
  } catch (error) {
    console.error("[signal-engine] retailer intelligence surface held", { error: String(error?.message || error) });
  } finally {
    monitoringRetailerIntelligence = false;
  }
}

if (env.databaseUrl) {
  const qualificationTimer = setTimeout(() => { void qualifyRetailerCandidates(); }, RETAILER_QUALIFICATION_START_DELAY_MS);
  qualificationTimer.unref();
  setInterval(qualifyRetailerCandidates, RETAILER_QUALIFICATION_INTERVAL_MS).unref();

  const curatedBranchTimer = setTimeout(() => { void syncCuratedRetailerBranches(); }, CURATED_BRANCH_SYNC_START_DELAY_MS);
  curatedBranchTimer.unref();
  setInterval(syncCuratedRetailerBranches, CURATED_BRANCH_SYNC_INTERVAL_MS).unref();

  const localBranchTimer = setTimeout(() => { void syncLocalRetailerBranches(); }, LOCAL_BRANCH_SYNC_START_DELAY_MS);
  localBranchTimer.unref();
  setInterval(syncLocalRetailerBranches, LOCAL_BRANCH_SYNC_INTERVAL_MS).unref();

  const osmBranchTimer = setTimeout(() => { void syncOsmRetailerBranches(); }, OSM_BRANCH_SYNC_START_DELAY_MS);
  osmBranchTimer.unref();
  setInterval(syncOsmRetailerBranches, OSM_BRANCH_SYNC_INTERVAL_MS).unref();

  const curatedLocalIntelTimer = setTimeout(() => { void reconcileCuratedLocalIntel(); }, CURATED_LOCAL_INTEL_START_DELAY_MS);
  curatedLocalIntelTimer.unref();
  setInterval(reconcileCuratedLocalIntel, CURATED_LOCAL_INTEL_INTERVAL_MS).unref();

  const totalCardsLocalTimer = setTimeout(() => { void reconcileTotalCardsLocal(); }, TOTAL_CARDS_LOCAL_START_DELAY_MS);
  totalCardsLocalTimer.unref();
  setInterval(reconcileTotalCardsLocal, TOTAL_CARDS_LOCAL_INTERVAL_MS).unref();

  const asdaDensityTimer = setTimeout(() => { void syncAsdaDensity(); }, ASDA_DENSITY_START_DELAY_MS);
  asdaDensityTimer.unref();
  setInterval(syncAsdaDensity, ASDA_DENSITY_INTERVAL_MS).unref();

  const cardmarketDailyTimer = setTimeout(() => { void syncCardmarketDailyPrices(); }, CARDMARKET_DAILY_START_DELAY_MS);
  cardmarketDailyTimer.unref();
  setInterval(syncCardmarketDailyPrices, CARDMARKET_DAILY_INTERVAL_MS).unref();

  if (env.encounters.retailerIntelligenceEnabled) {
    const retailerIntelligenceTimer = setTimeout(() => { void monitorRetailerIntelligence(); }, RETAILER_INTELLIGENCE_START_DELAY_MS);
    retailerIntelligenceTimer.unref();
    setInterval(monitorRetailerIntelligence, env.encounters.retailerIntelligenceIntervalMs).unref();
  }
}
