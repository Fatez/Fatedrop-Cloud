import { env } from "./config/env.mjs";
import { reconcileCuratedIncomingIntel } from "./encounters/curated-incoming-intel-reconcile.mjs";
import { ensureCuratedRetailerBranchSeeds } from "./encounters/curated-retailer-branch-seeds.mjs";
import { runNationalBranchDirectorySync } from "./encounters/national-branch-directory-sync.mjs";
import { runOsmRetailerBranchSync } from "./encounters/osm-retailer-branch-sync.mjs";
import { runCandidateQualificationCycle } from "./retailers/candidate-qualification.mjs";
import { createStore } from "./stores/index.mjs";
import "./server.mjs";

const RETAILER_QUALIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETAILER_QUALIFICATION_START_DELAY_MS = 10 * 1000;
const LOCAL_BRANCH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_BRANCH_SYNC_START_DELAY_MS = 20 * 1000;
const OSM_BRANCH_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OSM_BRANCH_SYNC_START_DELAY_MS = 45 * 1000;
const CURATED_LOCAL_INTEL_INTERVAL_MS = 30 * 60 * 1000;
const CURATED_LOCAL_INTEL_START_DELAY_MS = 90 * 1000;
const localBranchStore = createStore();
let qualifyingRetailerCandidates = false;
let syncingLocalBranches = false;
let syncingOsmBranches = false;
let reconcilingCuratedLocalIntel = false;

async function qualifyRetailerCandidates() {
  if (qualifyingRetailerCandidates || !env.databaseUrl) return;
  qualifyingRetailerCandidates = true;
  try {
    const outcome = await runCandidateQualificationCycle({ databaseUrl: env.databaseUrl });
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

if (env.databaseUrl) {
  const qualificationTimer = setTimeout(() => { void qualifyRetailerCandidates(); }, RETAILER_QUALIFICATION_START_DELAY_MS);
  qualificationTimer.unref();
  setInterval(qualifyRetailerCandidates, RETAILER_QUALIFICATION_INTERVAL_MS).unref();

  const localBranchTimer = setTimeout(() => { void syncLocalRetailerBranches(); }, LOCAL_BRANCH_SYNC_START_DELAY_MS);
  localBranchTimer.unref();
  setInterval(syncLocalRetailerBranches, LOCAL_BRANCH_SYNC_INTERVAL_MS).unref();

  const osmBranchTimer = setTimeout(() => { void syncOsmRetailerBranches(); }, OSM_BRANCH_SYNC_START_DELAY_MS);
  osmBranchTimer.unref();
  setInterval(syncOsmRetailerBranches, OSM_BRANCH_SYNC_INTERVAL_MS).unref();

  const curatedLocalIntelTimer = setTimeout(() => { void reconcileCuratedLocalIntel(); }, CURATED_LOCAL_INTEL_START_DELAY_MS);
  curatedLocalIntelTimer.unref();
  setInterval(reconcileCuratedLocalIntel, CURATED_LOCAL_INTEL_INTERVAL_MS).unref();
}
