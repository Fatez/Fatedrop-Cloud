import { load } from "cheerio";
import { env } from "../config/env.mjs";
import { extractCatalogueProducts } from "../core/extract.mjs";
import { sleep } from "../core/fetch.mjs";
import { currentRetailerScanSignal, retailerScanDeadlineError } from "../core/scan-deadline.mjs";

function requestHeaders(accept) {
  return {
    "user-agent": env.userAgent,
    accept,
    "accept-language": "en-GB,en;q=0.9",
  };
}

async function fetchText(url, accept) {
  const controller = new AbortController();
  const scanSignal = currentRetailerScanSignal();
  const abortFromScan = () => controller.abort(scanSignal?.reason);
  if (scanSignal?.aborted) abortFromScan();
  else scanSignal?.addEventListener("abort", abortFromScan, { once: true });
  const timer = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    if (scanSignal?.aborted) throw scanSignal.reason instanceof Error ? scanSignal.reason : retailerScanDeadlineError(null, env.scanDeadlineMs);
    const response = await fetch(url, { headers: requestHeaders(accept), redirect: "follow", signal: controller.signal });
    if (response.status === 403 || response.status === 401) throw new Error(`Retailer blocked catalogue request (${response.status}); adapter disabled for this scan — FateDrop will not bypass access controls.`);
    if (response.status === 429) throw new Error("Retailer rate-limited catalogue request (429); back off rather than bypassing the limit.");
    if (!response.ok) throw new Error(`catalogue request failed (${response.status})`);
    return { text: await response.text(), status: response.status };
  } catch (error) {
    if (scanSignal?.aborted) throw scanSignal.reason instanceof Error ? scanSignal.reason : retailerScanDeadlineError(null, env.scanDeadlineMs);
    if (controller.signal.aborted) {
      const timeoutError = new Error(`catalogue request timed out after ${env.fetchTimeoutMs}ms`);
      timeoutError.code = "retailer_request_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    scanSignal?.removeEventListener("abort", abortFromScan);
  }
}

export function sitemapLocations(xml) {
  const $ = load(xml, { xmlMode: true });
  return $("loc").map((_, node) => $(node).text().trim()).get().filter(Boolean);
}

function isProductSitemap(url) {
  return /xmlsitemap\.php\?.*\btype=products\b/i.test(url) || /(?:^|[-_/])products?(?:[-_.]|$)/i.test(new URL(url).pathname);
}

export function qualifiesProductUrl(url, retailer) {
  if (!retailer.productUrlPattern.test(url)) return false;
  const haystack = url.replaceAll("-", " ");
  const urlInclude = retailer.catalogue?.urlInclude;
  const urlExclude = retailer.catalogue?.urlExclude;
  if (urlInclude && !urlInclude.test(haystack)) return false;
  if (urlExclude && urlExclude.test(haystack)) return false;
  if (retailer.include && !retailer.include.test(haystack)) return false;
  if (retailer.exclude && retailer.exclude.test(haystack)) return false;
  return true;
}

function assertWithinSafetyCap(discoveredUrls, maxProductPages) {
  if (discoveredUrls.size > maxProductPages) {
    throw new Error(`BigCommerce product sitemap returned ${discoveredUrls.size} qualifying URLs, above safety cap ${maxProductPages}; preserving last valid catalogue.`);
  }
}

export async function scanBigCommerceSitemapCatalogue(retailer) {
  const sitemapUrl = retailer.catalogue?.sitemapUrl;
  if (!sitemapUrl) throw new Error("BigCommerce sitemap adapter requires catalogue.sitemapUrl");

  const maxProductPages = retailer.catalogue?.runtime?.maxProductPages ?? 800;
  const pages = [];
  const root = await fetchText(sitemapUrl, "application/xml,text/xml;q=0.9,*/*;q=0.8");
  pages.push({ pageUrl: sitemapUrl, discovered: 0, status: root.status });
  const rootLocations = sitemapLocations(root.text);

  const productSitemaps = rootLocations.filter(isProductSitemap);
  const directProductUrls = rootLocations.filter((url) => qualifiesProductUrl(url, retailer));
  const discoveredUrls = new Set(directProductUrls);
  assertWithinSafetyCap(discoveredUrls, maxProductPages);

  for (const productSitemapUrl of productSitemaps) {
    const response = await fetchText(productSitemapUrl, "application/xml,text/xml;q=0.9,*/*;q=0.8");
    const locations = sitemapLocations(response.text);
    const matching = locations.filter((url) => qualifiesProductUrl(url, retailer));
    matching.forEach((url) => discoveredUrls.add(url));
    pages.push({ pageUrl: productSitemapUrl, discovered: matching.length, status: response.status });
    assertWithinSafetyCap(discoveredUrls, maxProductPages);
  }

  const urls = [...discoveredUrls];
  if (urls.length === 0) throw new Error("BigCommerce product sitemap returned zero qualifying product URLs; preserving last valid catalogue.");

  const found = new Map();
  const concurrency = Math.max(1, Math.min(6, retailer.catalogue?.runtime?.productConcurrency ?? 4));
  const delayMs = Math.max(250, retailer.catalogue?.runtime?.productBatchDelayMs ?? 500);

  for (let offset = 0; offset < urls.length; offset += concurrency) {
    const batch = urls.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (productUrl) => {
      const response = await fetchText(productUrl, "text/html,application/xhtml+xml");
      const products = extractCatalogueProducts({ html: response.text, pageUrl: productUrl, retailer })
        .filter((item) => !retailer.include || retailer.include.test(`${item.title} ${item.url}`))
        .filter((item) => !retailer.exclude || !retailer.exclude.test(`${item.title} ${item.url}`));
      return { productUrl, status: response.status, products };
    }));

    for (const result of results) {
      for (const product of result.products) found.set(product.retailerSku, product);
      pages.push({ pageUrl: result.productUrl, discovered: result.products.length, status: result.status });
    }
    if (offset + concurrency < urls.length) await sleep(delayMs);
  }

  return { products: [...found.values()], pages };
}