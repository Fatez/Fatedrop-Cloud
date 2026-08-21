import test from "node:test";
import assert from "node:assert/strict";
import { parseAsmodeeCollectionProductUrls, parseAsmodeeProductPage } from "../src/rrp/asmodee-authority.mjs";

test("parses authoritative Asmodee Pokémon product metadata", () => {
  const html = `<!doctype html><html><body>
    <h1>Pokémon TCG: Mega Evolution Perfect Order - Elite Trainer Box (1)</h1>
    <div>The Pokémon Company Int. Inc. | Product Code (SKU): POK1010372111 | Barcode: 0196214152038</div>
    <div>RRP: £49.99</div>
    <div>Publisher: The Pokémon Company Int. Inc. Subcategory: Trading Card Games Family: Pokémon</div>
  </body></html>`;
  const result = parseAsmodeeProductPage(html, "https://www.asmodee.co.uk/products/test");
  assert.equal(result.title, "Pokémon TCG: Mega Evolution Perfect Order - Elite Trainer Box (1)");
  assert.equal(result.sku, "POK1010372111");
  assert.equal(result.barcode, "0196214152038");
  assert.equal(result.officialRrpPence, 4999);
  assert.match(result.publisher, /Pokémon Company/);
});

test("ignores duplicate collection links", () => {
  const html = `<a href="/products/foo">Foo</a><a href="/products/foo?variant=1">Foo again</a><a href="/products/bar">Bar</a>`;
  assert.deepEqual(parseAsmodeeCollectionProductUrls(html).sort(), [
    "https://www.asmodee.co.uk/products/bar",
    "https://www.asmodee.co.uk/products/foo",
  ]);
});

test("does not treat zero RRP as authoritative", () => {
  const html = `<html><body><h1>Pokémon TCG: Example</h1><div>Product Code (SKU): POK1 | Barcode: 1234567890123</div><div>RRP: £0.00</div><div>Publisher: The Pokémon Company Int. Inc. Subcategory: Trading Card Games</div></body></html>`;
  assert.equal(parseAsmodeeProductPage(html).officialRrpPence, null);
});
