import { extractCatalogueProducts } from "../core/extract.mjs";
import { fetchCataloguePage, sleep } from "../core/fetch.mjs";

function withPage(url, param, page) {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(param, String(page));
  return parsed.toString();
}

export async function scanRetailerCatalogue(retailer) {
  const found = new Map();
  const pages = [];
  for (const rootUrl of retailer.catalogueUrls) {
    let lastSize = -1;
    for (let page = 1; page <= retailer.maxPages; page += 1) {
      const pageUrl = withPage(rootUrl, retailer.pageParam, page);
      const response = await fetchCataloguePage(pageUrl);
      const products = extractCatalogueProducts({ html: response.html, pageUrl, retailer })
        .filter((item) => !retailer.include || retailer.include.test(`${item.title} ${item.url}`))
        .filter((item) => !retailer.exclude || !retailer.exclude.test(`${item.title} ${item.url}`));
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({ pageUrl, discovered: products.length, status: response.status });
      if (page > 1 && found.size === lastSize) break;
      lastSize = found.size;
      if (products.length === 0 && page > 1) break;
      if (page < retailer.maxPages) await sleep(retailer.delayMs);
    }
  }
  return { products: [...found.values()], pages };
}
