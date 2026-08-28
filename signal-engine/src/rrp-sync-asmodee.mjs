import { env } from "./config/env.mjs";
import { syncAsmodeeRrpWithPool } from "./rrp/asmodee-store-sync.mjs";
import { createStore } from "./stores/index.mjs";

try {
  const store = createStore();
  if (typeof store?.pool !== "function") throw new Error("Asmodee RRP sync requires the canonical PostgreSQL store");
  const result = await syncAsmodeeRrpWithPool({ pool: await store.pool() });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
