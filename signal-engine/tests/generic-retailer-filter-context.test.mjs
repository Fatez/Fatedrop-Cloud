import test from "node:test";
import assert from "node:assert/strict";
import { extractCatalogueProducts } from "../src/core/extract.mjs";

const retailer = {
  id: "tesco-context-test",
  productUrlPattern: /example\.test\/products\/\d+/i,
  skuPattern: /\/products\/(\d+)/i,
  include: /pokemon.*(?:tcg|trading card|booster|collection|tin|deck|blister|box)|(?:tcg|trading card).*pokemon/i,
  exclude: /marketplace|sold by marketplace seller|korean|tcym/i,
};

function pageHtml(extraCardText = "") {
  return `
    <html><body>
      <article class="product-card">
        <a href="/products/123"><h2>Pokemon TCG Booster Box</h2></a>
        <span class="price">£99.99</span>
        <span>${extraCardText}</span>
      </article>
      <script type="application/ld+json">
        {"@type":"Product","name":"Pokemon TCG Booster Box","url":"https://example.test/products/123","offers":{"price":"99.99","availability":"https://schema.org/InStock"}}
      </script>
    </body></html>`;
}

test("generic retailer exclusions can use surrounding product-card context", () => {
  const products = extractCatalogueProducts({
    html: pageHtml("Sold by Marketplace seller."),
    pageUrl: "https://example.test/pokemon",
    retailer,
  });
  assert.equal(products.length, 0, "marketplace card context must exclude both card and JSON-LD representations");
});

test("legitimate retailer-owned products still pass the same filters", () => {
  const products = extractCatalogueProducts({
    html: pageHtml("Sold and fulfilled by Example."),
    pageUrl: "https://example.test/pokemon",
    retailer,
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].retailerSku, "123");
  assert.equal(products[0].pricePence, 9999);
});
