import crypto from "node:crypto";

function safeDiagnostics(value) {
  return value && typeof value === "object" ? value : {};
}

export function createRetailerRunId(retailerId) {
  return `rrun_${String(retailerId || "retailer").replace(/[^a-z0-9_-]/gi, "_")}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function recordRetailerRunStart(store, { runId, retailerId, startedAt }) {
  if (!store || typeof store.pool !== "function") return { recorded: false, reason: "store_not_persistent" };
  const pool = await store.pool();
  await pool.query(
    `INSERT INTO fatedrop_retailer_monitor_runs
      (run_id,retailer_id,started_at,completed_at,status,pages_scanned,products_observed,catalogue_complete,published,failure_code,failure_detail,diagnostics)
     VALUES ($1,$2,$3,NULL,'running',0,0,false,false,NULL,NULL,'{}'::jsonb)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, retailerId, startedAt],
  );
  return { recorded: true, runId };
}

export async function recordRetailerRunFinish(store, {
  runId,
  completedAt,
  status,
  pagesScanned = 0,
  productsObserved = 0,
  catalogueComplete = false,
  published = false,
  failureCode = null,
  failureDetail = null,
  diagnostics = {},
}) {
  if (!store || typeof store.pool !== "function") return { recorded: false, reason: "store_not_persistent" };
  const pool = await store.pool();
  await pool.query(
    `UPDATE fatedrop_retailer_monitor_runs
     SET completed_at=$2,status=$3,pages_scanned=$4,products_observed=$5,catalogue_complete=$6,published=$7,failure_code=$8,failure_detail=$9,diagnostics=$10::jsonb
     WHERE run_id=$1`,
    [
      runId,
      completedAt,
      status,
      pagesScanned,
      productsObserved,
      catalogueComplete,
      published,
      failureCode,
      failureDetail == null ? null : String(failureDetail).slice(0, 1500),
      JSON.stringify(safeDiagnostics(diagnostics)),
    ],
  );
  return { recorded: true, runId };
}
