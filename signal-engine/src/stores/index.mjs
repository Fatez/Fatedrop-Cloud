import { env } from "../config/env.mjs";
import { assertProductionDatabaseTarget } from "./database-target.mjs";
import { FileStore } from "./file-store.mjs";
import { decorateRetailerHealthStore } from "./health-staleness.mjs";
import { PostgresStore } from "./postgres-store.mjs";

let storeInstance = null;
let storeInstanceKey = null;

function storeKey() {
  return env.store === "postgres"
    ? `postgres:${env.databaseUrl}`
    : `file:${env.filePath}`;
}

export function createStore() {
  const key = storeKey();
  if (storeInstance && storeInstanceKey === key) return storeInstance;

  if (env.store === "postgres") {
    if (!env.databaseUrl) throw new Error("FATEDROP_SIGNAL_STORE=postgres requires DATABASE_URL");
    assertProductionDatabaseTarget(env.databaseUrl);
    storeInstance = decorateRetailerHealthStore(new PostgresStore(env.databaseUrl));
  } else {
    storeInstance = decorateRetailerHealthStore(new FileStore(env.filePath));
  }

  storeInstanceKey = key;
  return storeInstance;
}
