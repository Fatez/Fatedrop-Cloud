import { env } from "../config/env.mjs";
import { evaluateHostedFateFinds } from "./fatefind.mjs";
import { dispatchNotificationOutbox } from "./notification-dispatch.mjs";

let poolPromise;
async function pool() {
  if (!env.databaseUrl) throw new Error("Hosted FateFind requires DATABASE_URL");
  if (!poolPromise) poolPromise = import("pg").then(({ Pool }) => new Pool({ connectionString: env.databaseUrl, ssl: env.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false } }));
  return poolPromise;
}

export async function runHostedFateFindCycle() {
  if (!env.hostedFateFind.enabled) return { enabled: false, evaluation: null, delivery: null };
  if (env.store !== "postgres") throw new Error("Hosted FateFind requires FATEDROP_SIGNAL_STORE=postgres");
  const database = await pool();
  const evaluation = await evaluateHostedFateFinds(database, { limit: env.hostedFateFind.maxFindsPerRun });
  const delivery = await dispatchNotificationOutbox(database);
  return { enabled: true, evaluation, delivery };
}
