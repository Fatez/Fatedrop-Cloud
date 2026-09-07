import test from "node:test";
import assert from "node:assert/strict";

import { retailerScannerKind } from "../src/adapters/index.mjs";
import { extractDirectProductPage } from "../src/core/extract.mjs";
import { effectivePurchasable } from "../src/core/preparation-intelligence.mjs";
import { retailers } from "../src/config/retailers.mjs";

const magic = retailers.find((retailer) => retailer.id === "magic-madhouse");

test("Magic Madhouse prefers official product sitemap over bounded category shell", () => {
  assert.ok(magic);
  assert.equal(retailerScannerKind(magic), "sitemap");
});

test("Magic Madhouse direct product stock wording qualifies as purchasable Manifested truth", () => {
  assert.ok(magic);
  const url = "https://magicmadhouse.co.uk/pokemon-scarlet-and-violet-paldea-evolved-booster-pack";
  const html = `
    <html><body>
      <main>
        <h1>Pokemon Scarlet & Violet: Paldea Evolved - Booster Pack</h1>
        <div class="price--withoutTax">£11.45</div>
        <div>Code: PZZSV02BP</div>
        <div>10+ in stock</div>
      </main>
    </body></html>`;

  const product = extractDirectProductPage({ html, pageUrl: url, retailer: magic });
  assert.ok(product);
  assert.equal(product.retailerSku, "PZZSV02BP");
  assert.equal(product.pricePence, 1145);
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.stockQuantity, null);
  assert.equal(effectivePurchasable({ ...product, retailerId: magic.id }), true);
});
