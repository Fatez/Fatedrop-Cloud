import assert from "node:assert/strict";
import test from "node:test";

import { recordCatalogueYield } from "../src/telemetry/catalogue-yield-context.mjs";
import { recordRetailerRunFinish, recordRetailerRunStart } from "../src/telemetry/retailer-runs.mjs";

test("retailer run diagnostics persist adapter discovery yield without changing engine semantics", async () => {
  const queries = [];
  const store = {
    async pool() {
      return {
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };
    },
  };

  await recordRetailerRunStart(store, { runId: "run-1", retailerId: "shop", startedAt: 100 });
  recordCatalogueYield("shop", {
    rawProductsSeen: 40,
    filteredOutProducts: 7,
    directRecoveryAttempted: 3,
    directRecoveryProductsSeen: 2,
  });
  await recordRetailerRunFinish(store, {
    runId: "run-1",
    completedAt: 110,
    status: "success",
    productsObserved: 35,
    diagnostics: { signalsCreated: 1 },
  });

  assert.equal(queries.length, 2);
  const persisted = JSON.parse(queries[1].params[9]);
  assert.equal(persisted.signalsCreated, 1);
  assert.equal(persisted.discovery.rawProductsSeen, 40);
  assert.equal(persisted.discovery.filteredOutProducts, 7);
  assert.equal(persisted.discovery.directRecoveryProductsSeen, 2);
});
