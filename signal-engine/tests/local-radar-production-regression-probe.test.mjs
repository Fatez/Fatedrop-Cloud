import test from "node:test";
import assert from "node:assert/strict";

test("read-only production Local Radar branch coverage probe", async () => {
  const url = new URL("https://fatedrop-cloud-production.up.railway.app/api/local-radar");
  url.searchParams.set("lat", "51.7000");
  url.searchParams.set("lng", "-0.0300");
  url.searchParams.set("radiusMiles", "25");
  url.searchParams.set("tcg", "pokemon");
  url.searchParams.set("types", "shops");

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  const shops = Array.isArray(payload.shops) ? payload.shops : [];
  const byRetailer = {};
  for (const shop of shops) {
    const key = String(shop.retailerId || "unmatched");
    byRetailer[key] = (byRetailer[key] || 0) + 1;
  }

  console.log("LOCAL_RADAR_PRODUCTION_PROBE", JSON.stringify({
    status: response.status,
    success: payload.success,
    shopCount: shops.length,
    byRetailer,
    branchIdentity: payload.providers?.branchIdentity || null,
    shopsProvider: payload.providers?.shops || null,
    locationResolution: payload.locationResolution || null,
  }));

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
});
