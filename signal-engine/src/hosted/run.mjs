import { env } from "../config/env.mjs";
import { createStore } from "../stores/index.mjs";
import { evaluateHostedFateFinds } from "./fatefind.mjs";
import { dispatchNotificationOutbox } from "./notification-dispatch.mjs";
import { buildFateMatchNotificationReadiness } from "./notification-readiness.mjs";

async function pool() {
  if (!env.databaseUrl) throw new Error("Hosted FateFind requires DATABASE_URL");
  const store = createStore();
  if (typeof store?.pool !== "function") throw new Error("Hosted FateFind requires the canonical PostgreSQL store");
  return store.pool();
}

export async function runHostedFateFindCycle() {
  if (!env.hostedFateFind.enabled) return { enabled: false, evaluation: null, delivery: null, readiness: null };
  if (env.store !== "postgres") throw new Error("Hosted FateFind requires FATEDROP_SIGNAL_STORE=postgres");
  const database = await pool();
  const evaluation = await evaluateHostedFateFinds(database, { limit: env.hostedFateFind.maxFindsPerRun });
  const delivery = await dispatchNotificationOutbox(database);
  const readiness = await buildFateMatchNotificationReadiness(database);
  return { enabled: true, evaluation, delivery, readiness };
}
