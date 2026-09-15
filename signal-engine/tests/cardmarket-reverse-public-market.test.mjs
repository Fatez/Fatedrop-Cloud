import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCardmarketReversePublicUrl,
  parseCardmarketReverseOffersHtml,
  summariseReverseOfferMarket,
} from '../src/trader/value/cardmarket-reverse-public-market.mjs';

test('reverse public URL keeps the certified product and replaces stray filters', () => {
  assert.equal(
    buildCardmarketReversePublicUrl('https://www.cardmarket.com/en/Pokemon/Products/Singles/Scarlet-Violet/Fidough-SVI097?language=3&isReverseHolo=N#offers'),
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/Scarlet-Violet/Fidough-SVI097?language=1&isReverseHolo=Y',
  );
});

test('parses only qualifying English reverse offers from the filtered product page', () => {
  const productUrl = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Scarlet-Violet/Fidough-SVI097';
  const filteredUrl = buildCardmarketReversePublicUrl(productUrl);
  const html = `
    <html><body>
      <div>Yes No Only Reverse?</div><label>Reverse Holo</label>
      <div id="table"><div class="table-body">
        <div class="article-row" id="articleRow10001">
          <div class="product-attributes"><span class="icon" aria-label="English"></span><span class="condition-container">Near Mint</span></div>
          <div class="col-offer"><div class="price-container"><span class="color-primary">1,20 €</span></div></div>
        </div>
        <div class="article-row" data-id-article="10002">
          <div class="product-attributes"><span class="icon" title="English"></span><span class="condition-container">Excellent</span></div>
          <div class="col-offer"><div class="price-container"><span class="color-primary">1,40 €</span></div></div>
        </div>
        <div class="article-row" id="articleRow10003">
          <div class="product-attributes"><span class="icon" aria-label="English"></span><span class="condition-container">Good</span></div>
          <div class="mobile-offer-container"><span class="color-primary">1,60 €</span></div>
        </div>
        <div class="article-row" id="articleRow10004">
          <div class="product-attributes"><span class="icon" aria-label="French"></span></div>
          <div class="col-offer"><div class="price-container"><span class="color-primary">0,20 €</span></div></div>
        </div>
        <div class="article-row" id="articleRow10005">
          <div class="product-attributes"><span class="icon" aria-label="English"></span><span class="icon" title="Signed"></span></div>
          <div class="col-offer"><div class="price-container"><span class="color-primary">0,10 €</span></div></div>
        </div>
      </div></div>
    </body></html>`;

  const parsed = parseCardmarketReverseOffersHtml(html, {
    sourceRecordId: '689768',
    productUrl,
    filteredUrl,
  });

  assert.equal(parsed.sourceRecordId, '689768');
  assert.equal(parsed.offers.length, 3);
  assert.deepEqual(parsed.offers.map((offer) => offer.articleId), ['10001', '10002', '10003']);
  assert.deepEqual(parsed.offers.map((offer) => offer.condition), ['NM', 'EX', 'GD']);
  assert.ok(parsed.offers.every((offer) => offer.language === 'English' && offer.isReverseHolo === true));
});

test('reverse Fate Price uses a robust offer sample rather than the cheapest listing', () => {
  const offers = [0.05, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 50]
    .map((price, index) => ({
      articleId: String(index + 1),
      currencyCode: 'EUR',
      price,
      language: 'English',
      condition: 'NM',
      isReverseHolo: true,
    }));
  const result = summariseReverseOfferMarket(offers, { minOffers: 3 });
  assert.equal(result.status, 'priced');
  assert.equal(result.lowPrice, 0.05);
  assert.equal(result.trimCountPerTail, 1);
  assert.ok(result.marketPrice > result.lowPrice);
  assert.equal(result.qualifyingOffers, 10);
  assert.equal(result.confidence, 'medium');
});

test('a successfully loaded but empty/thin reverse market stays explicitly unpriced', () => {
  assert.equal(summariseReverseOfferMarket([], { minOffers: 3 }).status, 'no_qualifying_offers');
  assert.equal(summariseReverseOfferMarket([
    { currencyCode: 'EUR', price: 1 },
    { currencyCode: 'EUR', price: 1.2 },
  ], { minOffers: 3 }).status, 'insufficient_offers');
});
