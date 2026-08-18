import { env } from "../config/env.mjs";
import { FileStore } from "./file-store.mjs";
import { PostgresStore } from "./postgres-store.mjs";

export function createStore() {
  if (env.store === "postgres") {
    if (!env.databaseUrl) throw new Error("FATEDROP_SIGNAL_STORE=postgres requires DATABASE_URL");
    return new PostgresStore(env.databaseUrl);
  }
  return new FileStore(env.filePath);
}
