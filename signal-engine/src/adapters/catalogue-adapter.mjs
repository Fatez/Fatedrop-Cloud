import { extractCatalogueProducts, extractDirectProductPage } from "../core/extract.mjs";
import { fetchCataloguePage, sleep } from "../core/fetch.mjs";
import { productProbeUrlsForRetailer } from "./evidence-probes.mjs";

function withPage(url, param, page) {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(param, String(page));
  return parsed.toString();
}

export async function scanRetailerCatalogue(retailer) {
  const found = new Map();
  const pages = [];
  let catalogueProductsSeen = 0;
  for (const rootUrl of retailer.catalogueUrls) {
    let lastSize = -1;
    for (let page = 1; page <= retailer.maxPages; page += 1) {
      const pageUrl = withPage(rootUrl, retailer.pageParam, page);
      const response = await fetchCataloguePage(pageUrl);
      const products = extractCatalogueProducts({ html: response.html, pageUrl, retailer })
        .filter((item) => !retailer.include || retailer.include.test(`${item.title} ${item.url}`))
        .filter((item) => !retailer.exclude || !retailer.exclude.test(`${item.title} ${item.url}`));
      catalogueProductsSeen += products.length;
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({ pageUrl, discovered: products.length, status: response.status, source: "catalogue" });
      if (page > 1 && found.size === lastSize) break;
      lastSize = found.size;
      if (products.length === 0 && page > 1) break;
      if (page < retailer.maxPages) await sleep(retailer.delayMs);
    }
  }

  let probeProductsSeen = 0;
  for (const pageUrl of productProbeUrlsForRetailer(retailer)) {
    const response = await fetchCataloguePage(pageUrl);
    const product = extractDirectProductPage({ html: response.html, pageUrl, retailer });
    const accepted = product && (!retailer.include || retailer.include.test(`${product.title} ${product.url}`)) && (!retailer.exclude || !retailer.exclude.test(`${product.title} ${product.url}`));
    if (accepted) {
      found.set(product.retailerSku, product);
      probeProductsSeen += 1;
    }
    pages.push({ pageUrl, discovered: accepted ? 1 : 0, status: response.status, source: "product_probe" });
  }

  return {
    products: [...found.values()],
    pages,
    partialCatalogue: catalogueProductsSeen === 0 && probeProductsSeen > 0,
    catalogueProductsSeen,
    probeProductsSeen,
  };
}
