import { env } from "../config/env.mjs";
import { FileStore } from "./file-store.mjs";
import { decorateRetailerHealthStore } from "./health-staleness.mjs";
import { PostgresStore } from "./postgres-store.mjs";

export function createStore() {
  if (env.store === "postgres") {
    if (!env.databaseUrl) throw new Error("FATEDROP_SIGNAL_STORE=postgres requires DATABASE_URL");
    return decorateRetailerHealthStore(new PostgresStore(env.databaseUrl));
  }
  return decorateRetailerHealthStore(new FileStore(env.filePath));
}
