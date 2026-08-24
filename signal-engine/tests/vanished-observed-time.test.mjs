import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscordSignalMessage } from "../src/notifications/discord.mjs";

function signal(state, extra = {}) {
  return {
    id: `sig-${state}`,
    state,
    kind: state === "vanished" ? "sold_out" : "availability_live",
    alertClass: "primary_drop",
    retailerId: "pokemon-center-uk",
    retailerName: "Pokémon Center UK",
    offerId: "off-1",
    productId: "prd-1",
    title: "Test Product",
    url: "https://example.com/product",
    pricePence: 4999,
    rrpPence: 4999,
    deliveredPricePence: 4999,
    markupPercent: 0,
    stockStatus: state === "vanished" ? "out_of_stock" : "in_stock",
    confidence: 0.99,
    detectedAt: 1000,
    ...extra,
  };
}

function field(message, name) {
  return message.embeds[0].fields.find((entry) => entry.name === name);
}

test("Vanished Discord alert can show a closed observed-live window", () => {
  const message = buildDiscordSignalMessage(signal("vanished", { observedDurationSeconds: 754 }));
  assert.equal(field(message, "Observed live")?.value, "12m 34s");
});

test("observed-live duration is never shown on Manifested", () => {
  const message = buildDiscordSignalMessage(signal("manifested", { observedDurationSeconds: 754 }));
  assert.equal(field(message, "Observed live"), undefined);
});
