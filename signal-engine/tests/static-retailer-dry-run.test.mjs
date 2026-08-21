import test from "node:test";
import assert from "node:assert/strict";
import { dryRunStaticRetailer, validateStaticDryRunRetailer } from "../src/retailers/static-dry-run.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

test("configured retailer dry run uses the exact static adapter config and writes nothing", async () => {
  const retailer = {
    id: "configured-shop",
    name: "Configured Shop",
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
    catalogueUrls: ["https://example.test/pokemon"],
    maxPages: 3,
    delayMs: 500,
    pageParam: "page",
    productUrlPattern: /example\.test\/product\//i,
    skuPattern: /product\/([^/?#]+)/i,
  };
  let received = null;
  const result = await dryRunStaticRetailer(retailer, {
    scanSource: async (input) => {
      received = input;
      return {
        products: [{ title: "Pokemon ETB", pricePence: 4999, stockStatus: "in_stock", url: "https://example.test/product/etb" }],
        pages: [{ status: 200 }],
      };
    },
  });
  assert.equal(received, retailer, "diagnostic must preserve the configured selectors and regexes exactly");
  assert.equal(result.persisted, false);
  assert.equal(result.published, false);
  assert.equal(result.diagnostics.productsObserved, 1);
  assert.match(result.note, /No product, offer, signal, health or registry state is written/i);
});

test("browser collectors are refused by the generic configured-retailer diagnostic", () => {
  assert.throws(
    () => validateStaticDryRunRetailer({ id: "pokemon-center-uk", adapterType: ADAPTER_TYPES.BROWSER_COLLECTOR }),
    /dedicated collector workflow/i,
  );
});
