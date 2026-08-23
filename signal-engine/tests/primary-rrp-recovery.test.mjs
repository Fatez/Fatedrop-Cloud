import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { qualifiesProductUrl } from "../src/adapters/bigcommerce-sitemap-adapter.mjs";
import { retailers } from "../src/config/retailers.mjs";

function retailer(id) {
  const value = retailers.find((entry) => entry.id === id);
  assert.ok(value, `${id} should remain enabled in the default retailer registry`);
  return value;
}

test("Smyths uses the current Pokémon TCG category path", () => {
  const smyths = retailer("smyths-uk");
  assert.deepEqual(smyths.catalogueUrls, [
    "https://www.smythstoys.com/uk/en-gb/toys/action-figures-and-playsets/pokemon-toys/pokemon-trading-card-game-tcg/c/SM0601011202",
  ]);
  assert.ok(!smyths.catalogueUrls[0].includes("/pokemon/pokemon-trading-card-game/"));
});

test("GAME gets a bounded retailer-specific catalogue timeout without changing the global timeout", () => {
  const game = retailer("game-uk");
  assert.equal(game.fetchTimeoutMs, 30_000);
  assert.ok(game.fetchTimeoutMs <= 45_000);

  const adapterSource = fs.readFileSync(new URL("../src/adapters/catalogue-adapter.mjs", import.meta.url), "utf8");
  const fetchSource = fs.readFileSync(new URL("../src/core/fetch.mjs", import.meta.url), "utf8");
  assert.match(adapterSource, /fetchCataloguePage\(pageUrl, retailer\.fetchTimeoutMs\)/);
  assert.match(fetchSource, /catalogue request timed out after \$\{requestTimeoutMs\}ms/);
  assert.match(fetchSource, /Math\.min\(45_000/);
});

test("Magic Madhouse sitemap discovery is narrowed to sealed-product URL evidence and keeps a hard cap", () => {
  const magic = retailer("magic-madhouse");
  assert.equal(magic.catalogue.runtime.maxProductPages, 1200);
  assert.ok(magic.catalogue.urlInclude instanceof RegExp);

  assert.equal(qualifiesProductUrl(
    "https://magicmadhouse.co.uk/pokemon-mega-evolution-ascended-heroes-booster-box",
    magic,
  ), true);
  assert.equal(qualifiesProductUrl(
    "https://magicmadhouse.co.uk/pokemon-lucario-cosmo-holo-scarlet-violet-stamp",
    magic,
  ), false);

  const source = fs.readFileSync(new URL("../src/adapters/bigcommerce-sitemap-adapter.mjs", import.meta.url), "utf8");
  assert.match(source, /retailer\.catalogue\?\.urlInclude/);
  assert.doesNotMatch(source, /retailer\.id === "magic-madhouse"/);
  assert.match(source, /above safety cap \$\{maxProductPages\}/);
});
