import test from "node:test";
import assert from "node:assert/strict";
import { inspectRetailerWebsite } from "../src/retailers/qualification-inspector.mjs";

test("qualification inspector finds platform, catalogue and delivery links without enabling monitoring", async () => {
  const html = `
    <html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body>
      <a href="/collections/pokemon-tcg">Pokemon TCG</a>
      <a href="/pages/delivery">Delivery information</a>
      <a href="https://elsewhere.example/cards">External cards</a>
    </body></html>`;
  const report = await inspectRetailerWebsite({ name: "Example", websiteUrl: "https://shop.example/" }, {
    fetchPage: async () => ({ html, status: 200 }),
  });
  assert.equal(report.adapterSuggestion, "shopify");
  assert.equal(report.catalogueCandidates[0].url, "https://shop.example/collections/pokemon-tcg");
  assert.equal(report.deliveryPolicyCandidates[0].url, "https://shop.example/pages/delivery");
  assert.deepEqual(report.platformEvidence, ["shopify-html-marker"]);
  assert.match(report.note, /no feed endpoint or monitoring approval/i);
});
