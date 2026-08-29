import { load } from "cheerio";
import { classifyStockStatus } from "./status.mjs";
import { canonicalKey, normalizeWhitespace, parseMoneyToPence, productTypeFromTitle, stableId } from "./normalize.mjs";

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
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

function normalizeExtractedProduct(raw, retailer, pageUrl, evidenceKind = "catalogue") {
  if (!raw?.title) return null;
  const url = raw.url ? absoluteUrl(raw.url, pageUrl) : null;
  if (!url || !retailer.productUrlPattern.test(url)) return null;
  const text = `${raw.rawText || ""} ${raw.availability || ""}`;
  const stock = classifyStockStatus(text);
  const productType = productTypeFromTitle(raw.title);
  const retailerSku = raw.sku || url.match(retailer.skuPattern)?.[1] || stableId("sku", retailer.id, url).slice(-16);
  return {
    retailerSku,
    title: normalizeWhitespace(raw.title),
    url,
    imageUrl: raw.imageUrl || null,
    pricePence: raw.pricePence ?? null,
    productType,
    canonicalKey: canonicalKey(raw.title, productType),
    stockStatus: stock.status,
    stockConfidence: stock.confidence,
    stockQuantity: stock.quantity ?? null,
    evidence: [{ kind: evidenceKind, value: stock.evidence, pageUrl }],
  };
}

function comparablePath(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function matchingJsonLdProduct($, pageUrl) {
  const products = jsonLdProducts($);
  const pageKey = comparablePath(pageUrl, pageUrl);
  return products.find((product) => comparablePath(product.url, pageUrl) === pageKey) || products[0] || null;
}

function attributeOrText($, node) {
  const element = $(node);
  return normalizeWhitespace(
    element.attr("content") ||
    element.attr("data-stock-status") ||
    element.attr("data-availability") ||
    element.attr("aria-label") ||
    element.attr("value") ||
    element.text()
  );
}

function productSpecificAvailabilityEvidence($, scope, pageUrl) {
  const structured = matchingJsonLdProduct($, pageUrl);
  if (structured?.availability) {
    return {
      text: normalizeWhitespace(structured.availability),
      kind: "product_page_json_ld_availability",
      structured,
    };
  }

  const selectors = [
    '[itemprop="availability"]',
    '[data-stock-status]',
    '[data-availability]',
    '.productView-stock',
    '.productView-availability',
    '.product-stock',
    '.stock-status',
    '.availability-status',
    '[class*="inventory"]',
    'button[data-add-to-cart]',
    '[data-action="add-to-cart"]',
    'button[name*="cart"]',
    'button[name*="basket"]',
    'form[action*="cart"] button[type="submit"]',
    'form[action*="basket"] button[type="submit"]',
  ];

  const values = [];
  for (const selector of selectors) {
    scope.find(selector).each((_, node) => {
      const value = attributeOrText($, node);
      if (value) values.push(value);
    });
  }
  const unique = [...new Set(values)];
  if (unique.length) {
    return {
      text: normalizeWhitespace(unique.join(" ")),
      kind: "product_page_purchase_controls",
      structured,
    };
  }

  return {
    text: normalizeWhitespace(scope.text()),
    kind: "product_page_fallback_text",
    structured,
  };
}

export function extractCatalogueProducts({ html, pageUrl, retailer }) {
  const $ = load(html);
  const fromLd = jsonLdProducts($);
  const fromCards = cardProducts($, retailer, pageUrl);
  const merged = new Map();
  for (const raw of [...fromCards, ...fromLd]) {
    const product = normalizeExtractedProduct(raw, retailer, pageUrl);
    if (!product) continue;
    const key = `${retailer.id}:${product.retailerSku}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      ...product,
      imageUrl: product.imageUrl || existing?.imageUrl || null,
      pricePence: product.pricePence ?? existing?.pricePence ?? null,
    });
  }
  return [...merged.values()];
}

export function extractDirectProductPage({ html, pageUrl, retailer }) {
  if (!retailer.productUrlPattern.test(pageUrl)) return null;
  const $ = load(html);
  const scope = $(".productView").first().length ? $(".productView").first() : $("main").first().length ? $("main").first() : $("body");
  const pageText = normalizeWhitespace(scope.text());
  const availability = productSpecificAvailabilityEvidence($, scope, pageUrl);
  const structured = availability.structured;
  const title = normalizeWhitespace(
    structured?.title ||
    scope.find("h1,.productView-title").first().text() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text()
  );
  if (!title || title.length < 4) return null;

  const priceCandidate = normalizeWhitespace(
    scope.find(".price--withoutTax,.price--main,[data-product-price-without-tax],[class*=price]").first().text()
  );
  const nowPrice = pageText.match(/\bNow\s*(£\s*[0-9][0-9,.]*)/i)?.[1] || null;
  const pricePence = structured?.pricePence ?? parseMoneyToPence(priceCandidate || nowPrice);
  const sku = normalizeWhitespace(
    structured?.sku ||
    scope.find("[data-product-sku],.productView-info-value").filter((_, node) => /[A-Z0-9-]{4,}/i.test($(node).text())).first().text()
  ) || pageText.match(/\bCode:\s*([A-Z0-9-]{4,})/i)?.[1] || null;
  const image = scope.find("img").filter((_, node) => /product|booster|trainer|collection|tin|pack/i.test(`${$(node).attr("alt") || ""} ${$(node).attr("class") || ""}`)).first();

  return normalizeExtractedProduct({
    title,
    url: pageUrl,
    imageUrl: structured?.imageUrl || absoluteUrl(image.attr("src") || image.attr("data-src"), pageUrl),
    sku,
    pricePence,
    rawText: availability.text,
  }, retailer, pageUrl, availability.kind);
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
