import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RRP_CONTEXT_CACHE_MS,
  decorateRrpContextReadCache,
} from "../src/stores/rrp-context-cache.mjs";

test("broad RRP context reads are coalesced and cached without caching ordinary product reads", async () => {
  let calls = 0;
  let now = 1_000_000;
  const store = {
    async listProducts(options) {
      calls += 1;
      await Promise.resolve();
      return [{ call: calls, options }];
    },
  };

  decorateRrpContextReadCache(store, { now: () => now });

  const [first, second] = await Promise.all([
    store.listProducts({ limit: 5000 }),
    store.listProducts({ limit: 5000 }),
  ]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);

  const cached = await store.listProducts({ limit: 5000 });
  assert.equal(calls, 1);
  assert.strictEqual(cached, first);

  await store.listProducts({ limit: 50 });
  assert.equal(calls, 2);

  await store.listProducts({ limit: 5000, rrpSource: "pokemon-center-uk" });
  assert.equal(calls, 3);

  now += DEFAULT_RRP_CONTEXT_CACHE_MS + 1;
  const refreshed = await store.listProducts({ limit: 5000 });
  assert.equal(calls, 4);
  assert.notStrictEqual(refreshed, first);
});

test("decorator is idempotent", async () => {
  let calls = 0;
  const store = {
    async listProducts() {
      calls += 1;
      return [];
    },
  };

  decorateRrpContextReadCache(store);
  decorateRrpContextReadCache(store);
  await store.listProducts({ limit: 5000 });
  await store.listProducts({ limit: 5000 });
  assert.equal(calls, 1);
});
