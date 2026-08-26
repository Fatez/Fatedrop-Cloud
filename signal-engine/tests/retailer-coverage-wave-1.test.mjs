import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalLaunchRetailers } from '../src/retailers/additional-launch-retailers.mjs';

test('coverage wave includes Travelling Man and The TCG Shop as approved Pokémon Shopify monitors', () => {
  const retailers = new Map(additionalLaunchRetailers().map((retailer) => [retailer.id, retailer]));

  const travellingMan = retailers.get('travelling-man-uk');
  assert.ok(travellingMan);
  assert.equal(travellingMan.adapterType, 'shopify');
  assert.equal(travellingMan.catalogue.feedApproved, true);
  assert.equal(travellingMan.catalogue.feedUrl, 'https://travellingman.com/collections/pokemon-tcg/products.json?limit=250');
  assert.equal(travellingMan.tcg, 'pokemon');
  assert.match('Pokemon TCG Destined Rivals Booster Pack', travellingMan.include);
  assert.doesNotMatch('Pokemon TCG 9-Pocket Portfolio', travellingMan.exclude);

  const tcgShop = retailers.get('the-tcg-shop-uk');
  assert.ok(tcgShop);
  assert.equal(tcgShop.adapterType, 'shopify');
  assert.equal(tcgShop.catalogue.feedApproved, true);
  assert.equal(tcgShop.catalogue.feedUrl, 'https://www.thetcgshop.co.uk/collections/pokemon/products.json?limit=250');
  assert.equal(tcgShop.tcg, 'pokemon');
  assert.match('Pokémon TCG Ascended Heroes Elite Trainer Box', tcgShop.include);
  assert.match('Pokémon card binder', tcgShop.exclude);
});
