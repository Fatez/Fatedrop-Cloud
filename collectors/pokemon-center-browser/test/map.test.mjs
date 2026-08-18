import test from "node:test";
import assert from "node:assert/strict";
import { mapAvailability, mapPokemonCenterDoc, priceToPence } from "../src/map.mjs";

test("maps Pokémon Center availability values", () => {
  assert.equal(mapAvailability("IN_STOCK"), "in_stock");
  assert.equal(mapAvailability(["OUT_OF_STOCK"]), "out_of_stock");
  assert.equal(mapAvailability("PRE-ORDER"), "preorder");
  assert.equal(mapAvailability("COMING_SOON"), "coming_soon");
});

test("converts catalogue prices to pence", () => {
  assert.equal(priceToPence(19.99), 1999);
  assert.equal(priceToPence("£54.99"), 5499);
});

test("maps selling price separately from official Pokémon Center RRP", () => {
  const mapped = mapPokemonCenterDoc({
    pid: "180-85010",
    title: "Example Pokémon TCG Product",
    availability_status: ["IN_STOCK"],
    sale_price: 24.99,
    price: 29.99,
    launch_date: "2026-08-20",
    url: "/en-gb/product/example/180-85010",
    primary_image: "/example.webp",
  });

  assert.equal(mapped.retailerSku, "180-85010");
  assert.equal(mapped.stockStatus, "in_stock");
  assert.equal(mapped.pricePence, 2499);
  assert.equal(mapped.officialRrpPence, 2999);
  assert.equal(mapped.stockConfidence, 0.99);
  assert.match(mapped.url, /^https:\/\/www\.pokemoncenter\.com\//);
  assert.ok(mapped.evidence.some((item) => item.kind === "pokemon_center_launch_date"));
  assert.ok(mapped.evidence.some((item) => item.kind === "pokemon_center_official_rrp"));
});
