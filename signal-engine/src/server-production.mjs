import { env } from "./config/env.mjs";
import { runNationalBranchDirectorySync } from "./encounters/national-branch-directory-sync.mjs";
import { runOsmRetailerBranchSync } from "./encounters/osm-retailer-branch-sync.mjs";
import { reconcileTotalCardsPhysicalAvailability } from "./encounters/total-cards-local-availability.mjs";
import { runCandidateQualificationCycle } from "./retailers/candidate-qualification.mjs";
import { createStore } from "./stores/index.mjs";
import "./server.mjs";

const RETAILER_QUALIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETAILER_QUALIFICATION_START_DELAY_MS = 10 * 1000;
const LOCAL_BRANCH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_BRANCH_SYNC_START_DELAY_MS = 20 * 1000;
const OSM_BRANCH_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OSM_BRANCH_SYNC_START_DELAY_MS = 45 * 1000;
const TOTAL_CARDS_LOCAL_INTERVAL_MS = 5 * 60 * 1000;
const TOTAL_CARDS_LOCAL_START_DELAY_MS = 120 * 1000;
const localBranchStore = createStore();
let qualifyingRetailerCandidates = false;
let syncingLocalBranches = false;
let syncingOsmBranches = false;
let reconcilingTotalCardsLocal = false;

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

  const totalCardsLocalTimer = setTimeout(() => { void reconcileTotalCardsLocal(); }, TOTAL_CARDS_LOCAL_START_DELAY_MS);
  totalCardsLocalTimer.unref();
  setInterval(reconcileTotalCardsLocal, TOTAL_CARDS_LOCAL_INTERVAL_MS).unref();
}
