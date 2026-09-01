import assert from "node:assert/strict";
import test from "node:test";

import { parseEntertainerPokemonAllocationSurface } from "../src/encounters/retailer-intelligence-parser.mjs";

const renderedText = `
POKÉMON AT THE ENTERTAINER
Stock is limited. We cannot guarantee a selected store will have stock upon arrival.
Pokémon TCG: Elite Trainer Box - 30th Celebration
Released: September 16th
Group A
You may only purchase 1 item from Group A
The Entertainer Bluewater - Greenhithe
The Entertainer Watford
Only stores listed will receive limited stock
Pokémon TCG: Tech Sticker Collection - 30th Celebration
Released: September 16th
Group C
You may only purchase 1 item from Group C
The Entertainer Watford
Only stores listed will receive limited stock
`;

test("The Entertainer allocation parser preserves product, group, limit and exact branch evidence", () => {
  const result = parseEntertainerPokemonAllocationSurface({
    renderedText,
    pageTitle: "Pokemon at The Entertainer",
    headings: ["POKÉMON AT THE ENTERTAINER", "Pokémon TCG: Elite Trainer Box - 30th Celebration"],
    links: [
      { text: "The Entertainer Watford", href: "https://www.thetoyshop.com/store/watford" },
      { text: "The Entertainer Bluewater - Greenhithe", href: "https://www.thetoyshop.com/store/bluewater" },
    ],
    images: [{ alt: "Pokémon TCG: Elite Trainer Box - 30th Celebration", src: "https://www.thetoyshop.com/assets/586561-etb.jpg" }],
  });

  assert.equal(result.products.length, 2);
  assert.equal(result.availabilityDisclaimerPresent, true);
  assert.equal(result.storeSearchSemantics, "static_filter_only_not_inventory");
  assert.equal(result.products[0].releaseLabel, "Released: September 16th");
  assert.equal(result.products[0].allocationGroup, "Group A");
  assert.equal(result.products[0].purchaseLimit, "You may only purchase 1 item from Group A");
  assert.equal(result.products[0].allocationLimited, true);
  assert.deepEqual(result.products[0].branchTargets.map((branch) => branch.name), [
    "The Entertainer Bluewater - Greenhithe",
    "The Entertainer Watford",
  ]);
  assert.equal(result.products[0].branchTargets[1].storeUrl, "https://www.thetoyshop.com/store/watford");
  assert.deepEqual(result.products[0].assetReferenceHints, ["586561"]);
});
