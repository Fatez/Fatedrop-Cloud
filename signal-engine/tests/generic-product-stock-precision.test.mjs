import test from "node:test";
import assert from "node:assert/strict";
import { extractDirectProductPage } from "../src/core/extract.mjs";

const retailer = {
  id: "precision-shop",
  productUrlPattern: /example\.com\/products\//i,
  skuPattern: /products\/([a-z0-9-]+)/i,
};

const pageUrl = "https://example.com/products/test-etb";

test("JSON-LD product availability outranks unrelated out-of-stock page copy", () => {
  const html = `
    <html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Pokemon Test Elite Trainer Box",
        url: pageUrl,
        sku: "TEST-ETB-001",
        image: "https://example.com/test.jpg",
        offers: { price: "49.99", availability: "https://schema.org/InStock" },
      })}</script>
    </head><body><main>
      <h1>Pokemon Test Elite Trainer Box</h1>
      <div class="price">£49.99</div>
      <section class="recommendations">Another product is out of stock</section>
    </main></body></html>`;

  const product = extractDirectProductPage({ html, pageUrl, retailer });
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.pricePence, 4999);
  assert.equal(product.retailerSku, "TEST-ETB-001");
  assert.equal(product.evidence[0].kind, "product_page_json_ld_availability");
});

test("JSON-LD out-of-stock truth outranks unrelated add-to-basket copy", () => {
  const html = `
    <html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Pokemon Test Booster Bundle",
        url: pageUrl,
        sku: "TEST-BUNDLE-001",
        offers: { price: "24.99", availability: "https://schema.org/OutOfStock" },
      })}</script>
    </head><body><main>
      <h1>Pokemon Test Booster Bundle</h1>
      <div class="recommendations"><button>Add to basket</button></div>
    </main></body></html>`;

  const product = extractDirectProductPage({ html, pageUrl, retailer });
  assert.equal(product.stockStatus, "out_of_stock");
  assert.equal(product.evidence[0].kind, "product_page_json_ld_availability");
});

test("tight product stock controls outrank unrelated body copy when JSON-LD is absent", () => {
  const html = `
    <html><body><main>
      <h1>Pokemon Test Booster Box</h1>
      <div class="price">£109.99</div>
      <div class="product-stock">In stock</div>
      <section class="recommendations">Popular item: sold out</section>
    </main></body></html>`;

  const product = extractDirectProductPage({ html, pageUrl, retailer });
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.evidence[0].kind, "product_page_purchase_controls");
});
