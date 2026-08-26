import assert from "node:assert/strict";
import test from "node:test";
import { scanRetailerSource } from "../src/adapters/index.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

const categoryUrl = "https://magicmadhouse.co.uk/pokemon/pokemon-sealed-product";
const sitemapUrl = "https://magicmadhouse.co.uk/xmlsitemap.php";

const retailer = {
  id: "magic-madhouse",
  name: "Magic Madhouse",
  adapterType: ADAPTER_TYPES.GENERIC_HTML,
  baseUrl: "https://magicmadhouse.co.uk/",
  catalogueUrls: [categoryUrl],
  catalogue: { sitemapUrl },
  productUrlPattern: /magicmadhouse\.co\.uk\/pokemon-[a-z0-9][a-z0-9-]+\/?(?:\?.*)?$/i,
  skuPattern: /\/pokemon-([^/?#]+)/i,
  pageParam: "page",
  maxPages: 1,
  delayMs: 250,
  include: /pokemon|pokémon/i,
  exclude: /\bsingle\b|code card|sleeve|binder only|playmat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b/i,
};

const categoryHtml = `<!doctype html><html><body>
<article class="card product">
  <a href="/pokemon-me-perfect-order-booster-box" title="Pokemon ME Perfect Order Booster Box">
    <h3 class="card-title">Pokemon ME Perfect Order Booster Box</h3>
    <img alt="Pokemon ME Perfect Order Booster Box" src="/images/perfect-order.jpg">
  </a>
  <span class="price price--withoutTax">£229.95</span>
  <span>Add to Cart</span>
</article>
</body></html>`;

test("Magic Madhouse uses its bounded category catalogue instead of sitemap product-page fan-out", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === categoryUrl) {
      return new Response(categoryHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await scanRetailerSource(retailer);
    assert.deepEqual(requested, [categoryUrl]);
    assert.equal(requested.includes(sitemapUrl), false);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, "Pokemon ME Perfect Order Booster Box");
    assert.equal(result.products[0].pricePence, 22995);
    assert.equal(result.products[0].stockStatus, "in_stock");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
