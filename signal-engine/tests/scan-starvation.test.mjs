import test from "node:test";
import assert from "node:assert/strict";

import { scanBigCommerceSitemapCatalogue } from "../src/adapters/bigcommerce-sitemap-adapter.mjs";
import { env } from "../src/config/env.mjs";
import { scanAll } from "../src/core/engine.mjs";

test("a slow retailer does not prevent later retailers from starting", async () => {
  const originalConcurrency = env.scanConcurrency;
  env.scanConcurrency = 2;
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  let thirdStarted = false;

  const retailers = [
    { id: "slow", name: "Slow" },
    { id: "fast-one", name: "Fast One" },
    { id: "fast-two", name: "Fast Two" },
  ];

  try {
    const run = scanAll({
      retailers,
      store: {},
      scanRetailerFn: async ({ retailer }) => {
        if (retailer.id === "slow") await slowGate;
        if (retailer.id === "fast-two") thirdStarted = true;
        return { retailerId: retailer.id, retailerName: retailer.name, signalsCreated: 0, signals: [] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(thirdStarted, true);
    releaseSlow();

    const results = await run;
    assert.deepEqual(results.map((result) => result.retailerId), ["slow", "fast-one", "fast-two"]);
  } finally {
    env.scanConcurrency = originalConcurrency;
  }
});

test("BigCommerce sitemap discovery fails fast once the safety cap is exceeded", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const root = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://shop.test/xmlsitemap.php?type=products&amp;page=1</loc></sitemap>
    <sitemap><loc>https://shop.test/xmlsitemap.php?type=products&amp;page=2</loc></sitemap>
  </sitemapindex>`;
  const firstProducts = `<?xml version="1.0"?><urlset>
    <url><loc>https://shop.test/pokemon-one</loc></url>
    <url><loc>https://shop.test/pokemon-two</loc></url>
    <url><loc>https://shop.test/pokemon-three</loc></url>
  </urlset>`;

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = calls.length === 1 ? root : firstProducts;
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  };

  const retailer = {
    productUrlPattern: /shop\.test\/pokemon-/i,
    include: /pokemon/i,
    exclude: null,
    catalogue: {
      sitemapUrl: "https://shop.test/xmlsitemap.php",
      runtime: { maxProductPages: 2 },
    },
  };

  try {
    await assert.rejects(
      () => scanBigCommerceSitemapCatalogue(retailer),
      /above safety cap 2/,
    );
    assert.equal(calls.length, 2, "second product sitemap must not be fetched after the cap is exceeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
