import assert from "node:assert/strict";
import test from "node:test";
import { retailerScannerKind } from "../src/adapters/index.mjs";
import { retailers } from "../src/config/retailers.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

test("Magic Madhouse selects the bounded category scanner instead of sitemap fan-out", () => {
  const magic = retailers.find((retailer) => retailer.id === "magic-madhouse");
  assert.ok(magic);
  assert.ok(Array.isArray(magic.catalogueUrls) && magic.catalogueUrls.length > 0);
  assert.ok(magic.catalogue?.sitemapUrl);
  assert.equal(retailerScannerKind(magic), "generic");
});

test("generic HTML sitemap remains an explicit fallback when no category catalogue is configured", () => {
  const sitemapOnly = {
    id: "sitemap-only",
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
    catalogue: { sitemapUrl: "https://example.test/sitemap.xml" },
  };
  assert.equal(retailerScannerKind(sitemapOnly), "sitemap");
});

test("structured retailer routing is unchanged by the Magic Madhouse recovery", () => {
  assert.equal(retailerScannerKind({ adapterType: ADAPTER_TYPES.SHOPIFY }), "structured");
  assert.equal(retailerScannerKind({ adapterType: ADAPTER_TYPES.WOOCOMMERCE }), "structured");
});
