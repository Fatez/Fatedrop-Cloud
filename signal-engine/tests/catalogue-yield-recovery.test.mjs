import assert from "node:assert/strict";
import test from "node:test";

import { unresolvedProductLinks } from "../src/adapters/catalogue-adapter.mjs";

test("catalogue recovery selects only product links not represented by parsed cards", () => {
  const discovered = [
    "https://shop.example/products/alpha?variant=1",
    "https://shop.example/products/beta",
    "https://shop.example/products/gamma#details",
    "https://shop.example/products/beta",
  ];
  const represented = [
    "https://shop.example/products/alpha",
    "https://shop.example/products/gamma/",
  ];

  assert.deepEqual(unresolvedProductLinks(discovered, represented), [
    "https://shop.example/products/beta",
  ]);
});

test("catalogue recovery treats query-string variants as the same product page", () => {
  assert.deepEqual(unresolvedProductLinks([
    "https://shop.example/products/alpha?utm_source=category",
  ], [
    "https://shop.example/products/alpha?variant=123",
  ]), []);
});
