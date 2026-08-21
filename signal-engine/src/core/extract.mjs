import { load } from "cheerio";
import { classifyStockStatus } from "./status.mjs";
import { canonicalKey, normalizeWhitespace, parseMoneyToPence, productTypeFromTitle, stableId } from "./normalize.mjs";

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function matches(pattern, value) {
  if (!pattern) return false;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function jsonLdProducts($) {
  const products = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    const raw = $(node).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (item["@graph"]) queue.push(...(Array.isArray(item["@graph"]) ? item["@graph"] : [item["@graph"]]));
        if (item.itemListElement) queue.push(...(Array.isArray(item.itemListElement) ? item.itemListElement : [item.itemListElement]));
        if (item.item && typeof item.item === "object") queue.push(item.item);
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (!types.includes("Product")) continue;
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        products.push({
          title: item.name,
          url: item.url,
          imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
          sku: item.sku || item.mpn || null,
          pricePence: parseMoneyToPence(offers?.price),
          availability: offers?.availability || "",
          rawText: `${item.name || ""} ${offers?.availability || ""}`,
        });
      }
    } catch { /* malformed JSON-LD is ignored */ }
  });
  return products;
}

function cardProducts($, config, pageUrl) {
  const products = [];
  const seen = new Set();
  const selector = config.cardSelector || "article, li, [class*=product], [data-product]";
  $(selector).each((_, node) => {
    const card = $(node);
    // Retailer catalogue cards commonly use relative hrefs. Resolve each link
    // before applying the retailer URL pattern; otherwise valid links such as
    // `/uk/en-gb/.../p/12345` are discarded before they become absolute URLs.
    const anchor = card.find('a[href]').filter((__, a) => {
      const candidate = absoluteUrl($(a).attr('href'), pageUrl);
      return Boolean(candidate && config.productUrlPattern.test(candidate));
    }).first();
    if (!anchor.length) return;
    const url = absoluteUrl(anchor.attr("href"), pageUrl);
    if (!url || seen.has(url)) return;
    const text = normalizeWhitespace(card.text());
    if (!text || text.length > 4000) return;
    const title = normalizeWhitespace(
      card.find(config.titleSelector || "h1,h2,h3,h4,[class*=title],[class*=name]").first().text() ||
      anchor.attr("title") || anchor.text()
    );
    if (!title || title.length < 4) return;
    const priceText = card.find(config.priceSelector || "[class*=price], [data-price]").first().text() || text;
    const image = card.find("img").first();
    seen.add(url);
    products.push({ title, url, imageUrl: absoluteUrl(image.attr("src") || image.attr("data-src"), pageUrl), sku: card.attr("data-sku") || null, pricePence: parseMoneyToPence(priceText), rawText: text });
  });
  return products;
}

export function extractCatalogueProducts({ html, pageUrl, retailer }) {
  const $ = load(html);
  const fromLd = jsonLdProducts($);
  const fromCards = cardProducts($, retailer, pageUrl);
  const cardContextByUrl = new Map();
  for (const raw of fromCards) {
    const url = raw.url ? absoluteUrl(raw.url, pageUrl) : null;
    if (url) cardContextByUrl.set(url, raw.rawText || "");
  }

  const merged = new Map();
  for (const raw of [...fromCards, ...fromLd]) {
    if (!raw.title) continue;
    const url = raw.url ? absoluteUrl(raw.url, pageUrl) : null;
    if (!url || !retailer.productUrlPattern.test(url)) continue;
    const text = normalizeWhitespace(`${raw.rawText || ""} ${raw.availability || ""} ${cardContextByUrl.get(url) || ""}`);
    const filterText = normalizeWhitespace(`${raw.title} ${url} ${text}`);
    if (retailer.include && !matches(retailer.include, filterText)) continue;
    if (retailer.exclude && matches(retailer.exclude, filterText)) continue;

    const stock = classifyStockStatus(text);
    const productType = productTypeFromTitle(raw.title);
    const retailerSku = raw.sku || url.match(retailer.skuPattern)?.[1] || stableId("sku", retailer.id, url).slice(-16);
    const key = `${retailer.id}:${retailerSku}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      retailerSku,
      title: normalizeWhitespace(raw.title),
      url,
      imageUrl: raw.imageUrl || existing?.imageUrl || null,
      pricePence: raw.pricePence ?? existing?.pricePence ?? null,
      productType,
      canonicalKey: canonicalKey(raw.title, productType),
      stockStatus: stock.status,
      stockConfidence: stock.confidence,
      stockQuantity: stock.quantity ?? null,
      evidence: [{ kind: "catalogue", value: stock.evidence, pageUrl }],
    });
  }
  return [...merged.values()];
}

export function discoverProductLinks({ html, pageUrl, retailer }) {
  const $ = load(html);
  const links = new Set();
  $('a[href]').each((_, node) => {
    const url = absoluteUrl($(node).attr("href"), pageUrl);
    if (url && retailer.productUrlPattern.test(url)) links.add(url.split("#")[0]);
  });
  return [...links];
}
