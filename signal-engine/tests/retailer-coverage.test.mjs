import test from "node:test";
import assert from "node:assert/strict";
import { retailers } from "../src/config/retailers.mjs";
import { scanStructuredCatalogue } from "../src/adapters/structured-catalogue-adapter.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

const priorityIds = [
  "pokemon-center-uk",
  "smyths-uk",
  "chaos-cards",
  "hamleys-uk",
  "asda-uk",
  "tesco-uk",
  "entertainer-uk",
  "game-uk",
  "argos-uk",
  "magic-madhouse",
  "double-sleeved",
  "total-cards",
  "titan-cards",
  "eterna-cards",
  "card-collective",
  "jet-cards",
  "gathering-games",
  "zatu-games",
];

test("launch retailer coverage has unique priority sources", () => {
  const ids = retailers.map((retailer) => retailer.id);
  assert.equal(new Set(ids).size, ids.length, "retailer IDs must be unique");
  for (const id of priorityIds) assert.ok(ids.includes(id), `missing priority retailer ${id}`);
});

test("sealed product filters reject obvious merchandise without rejecting sleeved boosters", () => {
  const totalCards = retailers.find((retailer) => retailer.id === "total-cards");
  const game = retailers.find((retailer) => retailer.id === "game-uk");
  assert.ok(totalCards?.exclude);
  assert.ok(game?.exclude);

  for (const retailer of [totalCards, game]) {
    assert.equal(retailer.exclude.test("Pokemon TCG Sleeved Booster Pack"), false, retailer.id);
    assert.equal(retailer.exclude.test("Pokemon Card Sleeves"), true, retailer.id);
    assert.equal(retailer.exclude.test("Pokemon Sleeping Eevee Blind Box"), true, retailer.id);
    assert.equal(retailer.exclude.test("Pokemon 3D Fridge Magnet Blind Box"), true, retailer.id);
  }
  assert.equal(totalCards.scanDeadlineMs, 450_000);
  assert.equal(totalCards.scanIntervalSeconds, 900);
});

test("Shopify catalogue scanner paginates collection feeds", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  const makeProduct = (id) => ({
    id,
    handle: `pokemon-test-${id}`,
    title: `Pokemon TCG Booster Pack ${id}`,
    variants: [{ id: id * 10, sku: `SKU-${id}`, title: "Default Title", price: "5.99", available: true }],
    images: [],
  });
  const first = Array.from({ length: 250 }, (_, index) => makeProduct(index + 1));
  const second = [makeProduct(251)];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const page = new URL(url).searchParams.get("page");
    const products = page === "1" ? first : second;
    return new Response(JSON.stringify({ products }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await scanStructuredCatalogue({
      id: "test-shopify",
      name: "Test Shopify",
      baseUrl: "https://example.test/",
      adapterType: ADAPTER_TYPES.SHOPIFY,
      catalogue: {
        feedUrl: "https://example.test/collections/pokemon/products.json?limit=250",
        feedApproved: true,
        runtime: { maxPages: 4, delayMs: 250 },
      },
      include: /pokemon/i,
      exclude: null,
    });

    assert.equal(requested.length, 2);
    assert.match(requested[0], /page=1/);
    assert.match(requested[1], /page=2/);
    assert.equal(result.pages.length, 2);
    assert.equal(result.products.length, 251);
    assert.equal(result.products[250].retailerSku, "SKU-251");
    assert.equal(result.partialCatalogue, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Shopify max-page truncation is explicitly partial rather than false healthy", async () => {
  const originalFetch = globalThis.fetch;
  const products = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    handle: `pokemon-test-${index + 1}`,
    title: `Pokemon TCG Booster Pack ${index + 1}`,
    variants: [{ id: (index + 1) * 10, sku: `SKU-${index + 1}`, title: "Default Title", price: "5.99", available: true }],
    images: [],
  }));
  globalThis.fetch = async () => new Response(JSON.stringify({ products }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const result = await scanStructuredCatalogue({
      id: "truncated-shopify",
      name: "Truncated Shopify",
      baseUrl: "https://example.test/",
      adapterType: ADAPTER_TYPES.SHOPIFY,
      catalogue: {
        feedUrl: "https://example.test/collections/pokemon/products.json?limit=250",
        feedApproved: true,
        runtime: { maxPages: 1, delayMs: 250 },
      },
      include: /pokemon/i,
      exclude: null,
    });
    assert.equal(result.complete, false);
    assert.equal(result.partialCatalogue, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured filters do not reject products because the retailer hostname matches an exclude term", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    products: [{
      id: 1,
      handle: "pokemon-tcg-booster-box",
      title: "Pokemon TCG Booster Box",
      variants: [{ id: 10, sku: "DS-001", title: "Default Title", price: "99.99", available: true }],
      images: [],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await scanStructuredCatalogue({
      id: "double-sleeved-test",
      name: "Double Sleeved",
      baseUrl: "https://double-sleeved.test/",
      adapterType: ADAPTER_TYPES.SHOPIFY,
      catalogue: {
        feedUrl: "https://double-sleeved.test/collections/pokemon-tcg/products.json?limit=250",
        feedApproved: true,
        runtime: { maxPages: 1, delayMs: 250 },
      },
      include: /booster|box/i,
      exclude: /sleeve|binder|playmat/i,
    });

    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].retailerSku, "DS-001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
