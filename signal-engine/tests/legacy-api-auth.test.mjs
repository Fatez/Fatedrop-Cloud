import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.mjs";
import { createHttpServer } from "../src/http/server.mjs";

const store = {
  async stats() { return { productsTracked: 1, offersTracked: 1, currentlyAvailable: 1 }; },
  async listRetailers() { return [{ id: "retailer-a", name: "Retailer A" }]; },
  async listNetworkSnapshots() { return [{ generatedAt: 1 }]; },
  async listSignals() { return [{ id: "signal-a", state: "echo", detectedAt: 1 }]; },
};

async function withServer(fn) {
  const server = createHttpServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("legacy operational API fails closed and requires the exact configured bearer token", async () => {
  const previousApiToken = env.apiToken;
  try {
    await withServer(async (base) => {
      env.apiToken = "";
      for (const path of ["/v1/network", "/v1/retailers", "/v1/network/history", "/v1/signals"]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 401, `${path} must reject requests when the API token is unconfigured`);
      }

      env.apiToken = "expected-secret";
      const missing = await fetch(`${base}/v1/network`);
      assert.equal(missing.status, 401);

      const wrong = await fetch(`${base}/v1/network`, { headers: { authorization: "Bearer wrong-secret" } });
      assert.equal(wrong.status, 401);

      const valid = await fetch(`${base}/v1/network`, { headers: { authorization: "Bearer expected-secret" } });
      assert.equal(valid.status, 200);
      const payload = await valid.json();
      assert.equal(payload.stats.productsTracked, 1);

      const publicSignals = await fetch(`${base}/api/signals`);
      assert.equal(publicSignals.status, 200, "public canonical signal feed must remain available");
    });
  } finally {
    env.apiToken = previousApiToken;
  }
});
