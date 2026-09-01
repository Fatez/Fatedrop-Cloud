import assert from "node:assert/strict";
import test from "node:test";

import {
  __test as amazonAdapterTest,
  clearAmazonCreatorsTokenCacheForTest,
  scanAmazonCreatorsCatalogue,
  tokenEndpointForCredentialVersion,
} from "../src/adapters/amazon-creators-adapter.mjs";
import { normalizeAmazonCreatorsItem } from "../src/adapters/amazon-creators-normalizer.mjs";
import { retailerScannerKind } from "../src/adapters/index.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

function jsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; },
  };
}

function retailer(overrides = {}) {
  return {
    id: "amazon-uk",
    name: "Amazon UK Marketplace",
    tcg: "pokemon",
    baseUrl: "https://www.amazon.co.uk/",
    adapterType: ADAPTER_TYPES.STRUCTURED_FEED,
    include: /booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|bundle|box\b|pack\b/i,
    exclude: /\bsingle\b|code card|sleeve|binder|playmat|graded/i,
    catalogue: {
      provider: "amazon_creators_api",
      marketplace: "www.amazon.co.uk",
      searchTerms: ["Pokemon TCG Elite Trainer Box", "Pokemon TCG Booster Bundle"],
    },
    ...overrides,
  };
}

test("Amazon normalizer preserves explicit marketplace seller identity and expires offer content", () => {
  const observedAt = new Date("2026-09-01T10:00:00.000Z");
  const product = normalizeAmazonCreatorsItem({
    asin: "B0TEST1234",
    detailPageURL: "https://www.amazon.co.uk/dp/B0TEST1234?tag=fatedrop-21",
    images: { primary: { large: { url: "https://m.media-amazon.com/test.jpg" } } },
    itemInfo: { title: { displayValue: "Pokemon TCG Booster Bundle" } },
    offersV2: {
      listings: [{
        availability: { type: "IN_STOCK", maxOrderQuantity: 2 },
        condition: { value: "New" },
        isBuyBoxWinner: true,
        merchantInfo: { name: "Independent Cards Ltd" },
        price: { money: { amount: 31.95, currency: "GBP" } },
      }],
    },
  }, retailer(), { observedAt });

  assert.equal(product.retailerSku, "B0TEST1234");
  assert.equal(product.sellerName, "Independent Cards Ltd");
  assert.equal(product.pricePence, 3195);
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.stockQuantity, null, "max order quantity must not masquerade as stock quantity");
  assert.equal(product.providerContent.retentionClass, "ephemeral_offer");
  assert.equal(product.providerContent.observedAt, "2026-09-01T10:00:00.000Z");
  assert.equal(product.providerContent.expiresAt, "2026-09-01T11:00:00.000Z");
  assert.ok(product.evidence.some((entry) => entry.kind === "amazon_merchant" && entry.value === "Independent Cards Ltd"));
});

test("Amazon normalizer fails price closed for non-GBP and does not use used offers as new-stock truth", () => {
  const nonGbp = normalizeAmazonCreatorsItem({
    asin: "B0NONGBP",
    itemInfo: { title: { displayValue: "Pokemon TCG Elite Trainer Box" } },
    offersV2: { listings: [{
      availability: { type: "IN_STOCK" },
      condition: { value: "New" },
      merchantInfo: { name: "Amazon EU" },
      price: { money: { amount: 49.99, currency: "EUR" } },
    }] },
  }, retailer());
  assert.equal(nonGbp.pricePence, null);
  assert.equal(nonGbp.stockStatus, "in_stock");

  const usedOnly = normalizeAmazonCreatorsItem({
    asin: "B0USEDONLY",
    itemInfo: { title: { displayValue: "Pokemon TCG Booster Box" } },
    offersV2: { listings: [{
      availability: { type: "IN_STOCK" },
      condition: { value: "Used" },
      merchantInfo: { name: "Used Seller" },
      price: { money: { amount: 12, currency: "GBP" } },
    }] },
  }, retailer());
  assert.equal(usedOnly.pricePence, null);
  assert.equal(usedOnly.stockStatus, "unknown");
  assert.equal(usedOnly.sellerName, null);
});

test("Amazon Creators shadow scanner uses official UK SearchItems contract and stays provider-specific", async () => {
  clearAmazonCreatorsTokenCacheForTest();
  const requests = [];
  const payloads = [
    {
      searchResult: { items: [
        {
          asin: "B0ETB00001",
          detailPageURL: "https://www.amazon.co.uk/dp/B0ETB00001?tag=fatedrop-21",
          itemInfo: { title: { displayValue: "Pokemon TCG Elite Trainer Box" } },
          offersV2: { listings: [{
            availability: { type: "IN_STOCK" },
            condition: { value: "New" },
            isBuyBoxWinner: true,
            merchantInfo: { name: "Amazon.co.uk" },
            price: { money: { amount: 49.99, currency: "GBP" } },
          }] },
        },
        {
          asin: "B0SINGLE01",
          detailPageURL: "https://www.amazon.co.uk/dp/B0SINGLE01?tag=fatedrop-21",
          itemInfo: { title: { displayValue: "Pokemon TCG Single Card Charizard" } },
          offersV2: { listings: [{
            availability: { type: "IN_STOCK" },
            condition: { value: "New" },
            merchantInfo: { name: "Card Seller" },
            price: { money: { amount: 9.99, currency: "GBP" } },
          }] },
        },
      ] },
    },
    {
      searchResult: { items: [{
        asin: "B0BUNDLE01",
        detailPageURL: "https://www.amazon.co.uk/dp/B0BUNDLE01?tag=fatedrop-21",
        itemInfo: { title: { displayValue: "Pokemon TCG Booster Bundle" } },
        offersV2: { listings: [{
          availability: { type: "OUTOFSTOCK" },
          condition: { value: "New" },
          isBuyBoxWinner: true,
          merchantInfo: { name: "Cards R Us" },
          price: { money: { amount: 34.95, currency: "GBP" } },
        }] },
      }] },
    },
  ];
  let searchIndex = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: options?.body ? String(options.body) : "" });
    if (url === tokenEndpointForCredentialVersion("3.2")) {
      return jsonResponse(200, { access_token: "token-123", token_type: "bearer", expires_in: 3600 });
    }
    if (url === amazonAdapterTest.AMAZON_CREATORS_API_URL) {
      return jsonResponse(200, payloads[searchIndex++]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const fixedNow = Date.parse("2026-09-01T10:00:00.000Z");
  const result = await scanAmazonCreatorsCatalogue(retailer(), {
    fetchImpl,
    now: () => fixedNow,
    credentials: {
      configured: true,
      clientId: "client-id",
      clientSecret: "client-secret",
      partnerTag: "fatedrop-21",
      credentialVersion: "3.2",
      marketplace: "www.amazon.co.uk",
    },
  });

  assert.equal(retailerScannerKind(retailer()), "amazon_creators");
  assert.equal(requests.filter((entry) => entry.url === tokenEndpointForCredentialVersion("3.2")).length, 1);
  const searches = requests.filter((entry) => entry.url === amazonAdapterTest.AMAZON_CREATORS_API_URL);
  assert.equal(searches.length, 2);
  const firstBody = JSON.parse(searches[0].body);
  assert.equal(firstBody.marketplace, "www.amazon.co.uk");
  assert.equal(firstBody.partnerTag, "fatedrop-21");
  assert.equal(firstBody.searchIndex, "ToysAndGames");
  assert.equal(firstBody.condition, "New");
  assert.equal(firstBody.availability, "IncludeOutOfStock");
  assert.deepEqual(firstBody.languagesOfPreference, ["en_GB"]);
  assert.equal(firstBody.currencyOfPreference, "GBP");
  assert.ok(firstBody.resources.includes("offersV2.listings.merchantInfo"));
  assert.equal(searches[0].options.headers["x-marketplace"], "www.amazon.co.uk");
  assert.equal(searches[0].options.headers.authorization, "Bearer token-123");

  assert.equal(result.products.length, 2, "single-card noise must be excluded from sealed-product monitoring");
  assert.equal(result.acceptedProductsSeen, 2);
  assert.equal(result.filteredOutProducts, 1);
  assert.equal(result.retentionClass, "ephemeral_offer");
  const thirdParty = result.products.find((product) => product.retailerSku === "B0BUNDLE01");
  assert.equal(thirdParty.sellerName, "Cards R Us");
  assert.equal(thirdParty.stockStatus, "out_of_stock");
});

test("Amazon Creators shadow scanner stays closed without approved credentials", async () => {
  await assert.rejects(
    scanAmazonCreatorsCatalogue(retailer(), { credentials: { configured: false } }),
    (error) => error?.code === "amazon_creators_credentials_required",
  );
});
