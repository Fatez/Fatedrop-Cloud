import assert from "node:assert/strict";
import test from "node:test";

import { extractCatalogueProducts, extractDirectProductPage } from "../src/core/extract.mjs";
import { deriveSignal } from "../src/core/signals.mjs";

const retailer = {
  id: "smyths-uk",
  name: "Smyths Toys UK",
  productUrlPattern: /smythstoys\.com\/uk\/en-gb\/.*\/p\/\d+/i,
  skuPattern: /\/p\/(\d+)/i,
};

const pageUrl = "https://www.smythstoys.com/uk/en-gb/toys/pokemon/c/SM0601011202";
const productUrl = "https://www.smythstoys.com/uk/en-gb/toys/pokemon/pokemon-tcg-test-elite-trainer-box/p/263973";

function offerFrom(product, extra = {}) {
  return {
    offerId: `off_${product.retailerSku}`,
    productId: `prd_${product.retailerSku}`,
    retailerId: retailer.id,
    retailerName: retailer.name,
    retailerSku: product.retailerSku,
    title: product.title,
    productType: product.productType,
    url: product.url,
    imageUrl: product.imageUrl,
    pricePence: product.pricePence,
    rrpPence: 4999,
    postagePence: 0,
    stockStatus: product.stockStatus,
    stockConfidence: product.stockConfidence,
    stockQuantity: product.stockQuantity,
    evidence: product.evidence,
    everAvailableAt: null,
    firstSeenAt: 100,
    lastSeenAt: 100,
    ...extra,
  };
}

function catalogueHtml(control = "") {
  return `
    <article class="product-card">
      <h2 class="product-title">Pokémon TCG Test Elite Trainer Box</h2>
      <a href="${productUrl}">View product</a>
      <span class="price">£49.99</span>
      <span class="stock">In stock</span>
      ${control}
    </article>
  `;
}

test("Smyths official catalogue listing is Whisper when stock wording exists but no purchase control is verified", () => {
  const [product] = extractCatalogueProducts({ html: catalogueHtml(), pageUrl, retailer });
  assert.equal(product.stockStatus, "in_stock");
  assert.ok(product.evidence.some((entry) => entry.kind === "official_retailer_catalogue_listing"));
  assert.ok(product.evidence.some((entry) => entry.kind === "purchase_verification_required"));
  assert.ok(!product.evidence.some((entry) => entry.kind === "add_to_cart_verified"));

  const signal = deriveSignal({ previousOffer: null, currentOffer: offerFrom(product), now: 200 });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "catalogue_new");
});

test("disabled Smyths Add to Basket control remains Whisper and does not Manifest", () => {
  const [product] = extractCatalogueProducts({
    html: catalogueHtml('<button disabled>Add to Basket</button>'),
    pageUrl,
    retailer,
  });
  assert.ok(!product.evidence.some((entry) => entry.kind === "add_to_cart_verified"));
  const signal = deriveSignal({ previousOffer: null, currentOffer: offerFrom(product), now: 200 });
  assert.equal(signal.state, "whisper");
});

test("enabled Smyths Add to Basket control verifies the purchase boundary and Manifests", () => {
  const [product] = extractCatalogueProducts({
    html: catalogueHtml('<button>Add to Basket</button>'),
    pageUrl,
    retailer,
  });
  assert.ok(product.evidence.some((entry) => entry.kind === "add_to_cart_verified"));
  const signal = deriveSignal({ previousOffer: null, currentOffer: offerFrom(product), now: 200 });
  assert.equal(signal.state, "manifested");
  assert.equal(signal.kind, "new_listing_live");
});

test("unchanged Smyths staged listing does not repeat Whisper every scan", () => {
  const [product] = extractCatalogueProducts({ html: catalogueHtml(), pageUrl, retailer });
  const previous = offerFrom(product, { firstSeenAt: 100, lastSeenAt: 200 });
  const current = offerFrom(product, { firstSeenAt: 100, lastSeenAt: 300 });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 300 });
  assert.equal(signal, null);
});

test("Smyths direct product page exposes Ref as SKU and Whispers without an active buy control", () => {
  const product = extractDirectProductPage({
    html: `
      <main>
        <h1>Pokémon Trading Card Game (TCG): 30th Celebration Sylveon ex Box</h1>
        <div>Ref: 263973</div>
        <p>Sylveon ex brings colour to your day!</p>
      </main>
    `,
    pageUrl: productUrl,
    retailer,
  });
  assert.equal(product.retailerSku, "263973");
  assert.equal(product.stockStatus, "unknown");
  assert.ok(product.evidence.some((entry) => entry.kind === "official_retailer_product_page"));
  assert.ok(!product.evidence.some((entry) => entry.kind === "add_to_cart_verified"));
  const signal = deriveSignal({ previousOffer: null, currentOffer: offerFrom(product), now: 200 });
  assert.equal(signal.state, "whisper");
});
