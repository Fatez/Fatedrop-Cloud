import test from "node:test";
import assert from "node:assert/strict";
import { scanBigCommerceSitemapCatalogue, sitemapLocations } from "../src/adapters/bigcommerce-sitemap-adapter.mjs";

const retailer = {
  id: "magic-madhouse",
  name: "Magic Madhouse",
  baseUrl: "https://magicmadhouse.co.uk/",
  catalogue: {
    sitemapUrl: "https://magicmadhouse.co.uk/xmlsitemap.php",
    runtime: { maxProductPages: 20, productConcurrency: 2, productBatchDelayMs: 250 },
  },
  productUrlPattern: /magicmadhouse\.co\.uk\/pokemon-[a-z0-9][a-z0-9-]+\/?(?:\?.*)?$/i,
  skuPattern: /\/pokemon-([^/?#]+)/i,
  include: /pokemon|pokémon/i,
  exclude: /\bsingle\b|code card|sleeve|binder only|playmat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b/i,
};

const rootSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://magicmadhouse.co.uk/xmlsitemap.php?type=products&amp;page=1</loc></sitemap>
  <sitemap><loc>https://magicmadhouse.co.uk/xmlsitemap.php?type=categories&amp;page=1</loc></sitemap>
</sitemapindex>`;

const productSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box</loc></url>
  <url><loc>https://magicmadhouse.co.uk/magic-some-other-product</loc></url>
</urlset>`;

const silverTempestPage = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"Product",
  "name":"Pokemon SWSH Silver Tempest Booster Box",
  "url":"https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box",
  "sku":"SWSH-SIT-BB",
  "image":"https://cdn.example.test/silver-tempest.jpg",
  "offers":{"@type":"Offer","price":"599.95","availability":"https://schema.org/InStock"}
}
</script></head><body>10+ in stock</body></html>`;

test("sitemap parser decodes public BigCommerce locations", () => {
  assert.deepEqual(sitemapLocations(rootSitemap), [
    "https://magicmadhouse.co.uk/xmlsitemap.php?type=products&page=1",
    "https://magicmadhouse.co.uk/xmlsitemap.php?type=categories&page=1",
  ]);
});

test("Magic Madhouse sitemap discovery verifies Silver Tempest from its product page", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === retailer.catalogue.sitemapUrl) return new Response(rootSitemap, { status: 200, headers: { "content-type": "application/xml" } });
    if (url.includes("type=products")) return new Response(productSitemap, { status: 200, headers: { "content-type": "application/xml" } });
    if (url === "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box") return new Response(silverTempestPage, { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await scanBigCommerceSitemapCatalogue(retailer);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, "Pokemon SWSH Silver Tempest Booster Box");
    assert.equal(result.products[0].retailerSku, "SWSH-SIT-BB");
    assert.equal(result.products[0].pricePence, 59995);
    assert.equal(result.products[0].stockStatus, "in_stock");
    assert.equal(requested.includes("https://magicmadhouse.co.uk/magic-some-other-product"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Magic Madhouse sitemap discovery fails closed when public discovery is empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<?xml version="1.0"?><urlset><url><loc>https://magicmadhouse.co.uk/magic-unrelated</loc></url></urlset>`, { status: 200 });
  try {
    await assert.rejects(() => scanBigCommerceSitemapCatalogue(retailer), /zero qualifying product URLs/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
