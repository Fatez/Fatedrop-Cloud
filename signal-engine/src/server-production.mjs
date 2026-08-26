import { env } from "./config/env.mjs";
import { runCandidateQualificationCycle } from "./retailers/candidate-qualification.mjs";
import "./server.mjs";

const RETAILER_QUALIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETAILER_QUALIFICATION_START_DELAY_MS = 10 * 1000;
let qualifyingRetailerCandidates = false;

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

if (env.databaseUrl) {
  const startupTimer = setTimeout(() => { void qualifyRetailerCandidates(); }, RETAILER_QUALIFICATION_START_DELAY_MS);
  startupTimer.unref();
  setInterval(qualifyRetailerCandidates, RETAILER_QUALIFICATION_INTERVAL_MS).unref();
}
