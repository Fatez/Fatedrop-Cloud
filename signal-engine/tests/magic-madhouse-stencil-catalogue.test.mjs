import assert from "node:assert/strict";
import test from "node:test";
import { scanRetailerCatalogue } from "../src/adapters/catalogue-adapter.mjs";
import { clearRetailerHostCooldownsForTest } from "../src/core/fetch.mjs";
import { retailers } from "../src/config/retailers.mjs";

test("Magic Madhouse requests the bounded BigCommerce product-listing fragment", async (t) => {
  const magic = retailers.find((retailer) => retailer.id === "magic-madhouse");
  assert.ok(magic);
  assert.equal(magic.catalogue?.stencilTemplate, "category/product-listing");

  const originalFetch = globalThis.fetch;
  const seenHeaders = [];
  clearRetailerHostCooldownsForTest();
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearRetailerHostCooldownsForTest();
  });

  globalThis.fetch = async (url, options = {}) => {
    seenHeaders.push(options.headers || {});
    const page = new URL(url).searchParams.get("page");
    const listing = page === "2" ? "" : `
      <article class="product">
        <h4 class="card-title">
          <a href="https://magicmadhouse.co.uk/pokemon-audit-elite-trainer-box/">Pokemon Audit Elite Trainer Box</a>
        </h4>
        <div class="price">£49.95</div>
        <span>Add to Cart</span>
      </article>
    `;
    return new Response(JSON.stringify({
      "components/category/product-listing": listing,
    }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const testCatalogueUrl = new URL(magic.catalogueUrls[0]);
  testCatalogueUrl.hostname = "magic-madhouse.test";
  testCatalogueUrl.searchParams.set("fatedrop_audit", "stencil");
  const retailer = {
    ...magic,
    id: "magic-madhouse-stencil-audit",
    catalogueUrls: [testCatalogueUrl.toString()],
    maxPages: 2,
    delayMs: 0,
  };
  const scan = await scanRetailerCatalogue(retailer);

  assert.equal(scan.partialCatalogue, false);
  assert.equal(scan.catalogueProductsSeen, 1);
  assert.equal(scan.products.length, 1);
  assert.equal(scan.products[0].title, "Pokemon Audit Elite Trainer Box");
  assert.equal(scan.products[0].pricePence, 4995);
  assert.equal(scan.products[0].stockStatus, "in_stock");
  assert.equal(scan.pages.filter((page) => page.source === "catalogue").length, 2);

  assert.ok(seenHeaders.length >= 2);
  for (const headers of seenHeaders.slice(0, 2)) {
    assert.equal(headers["x-requested-with"], "stencil-utils");
    assert.equal(headers["stencil-config"], "{}");
    assert.deepEqual(JSON.parse(headers["stencil-options"]), { render_with: "category/product-listing" });
  }
});
