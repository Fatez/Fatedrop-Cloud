import { load } from "cheerio";
import { classifyStockStatus } from "./status.mjs";
import { canonicalKey, normalizeWhitespace, parseMoneyToPence, productTypeFromTitle, stableId } from "./normalize.mjs";
import { retailerLifecyclePolicy } from "./retailer-lifecycle-policy.mjs";

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function purchaseControlEvidence($, scope) {
  let evidence = null;
  scope.find('button,input[type="submit"],a[role="button"],a').each((_, node) => {
    if (evidence) return;
    const control = $(node);
    const label = normalizeWhitespace(
      control.text() || control.attr("value") || control.attr("aria-label") || control.attr("title") || ""
    );
    if (!/\badd to basket\b|\badd to cart\b|\bbuy now\b/i.test(label)) return;
    const disabled = control.is("[disabled]")
      || String(control.attr("aria-disabled") || "").toLowerCase() === "true"
      || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(control.attr("class") || "");
    if (disabled) return;
    evidence = {
      kind: /\bbuy now\b/i.test(label) ? "purchase_path_verified" : "add_to_cart_verified",
      value: label,
    };
  });
  return evidence;
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
    products.push({
      title,
      url,
      imageUrl: absoluteUrl(image.attr("src") || image.attr("data-src"), pageUrl),
      sku: card.attr("data-sku") || null,
      pricePence: parseMoneyToPence(priceText),
      rawText: text,
      purchaseEvidence: purchaseControlEvidence($, card),
    });
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
  const lifecyclePolicy = retailerLifecyclePolicy(retailer.id);
  const evidence = [{ kind: evidenceKind, value: stock.evidence, pageUrl }];
  if (evidenceKind === "catalogue" && lifecyclePolicy.officialCatalogueListingEvidence) {
    evidence.push({ kind: "official_retailer_catalogue_listing", value: url, pageUrl });
  }
  if (evidenceKind === "product_page_probe" && lifecyclePolicy.officialProductPageEvidence) {
    evidence.push({ kind: "official_retailer_product_page", value: url, pageUrl });
  }
  if (lifecyclePolicy.requireVerifiedPurchaseEvidence) {
    evidence.push({ kind: "purchase_verification_required", value: "retailer_policy", pageUrl });
  }
  if (raw.purchaseEvidence?.kind) {
    evidence.push({ ...raw.purchaseEvidence, pageUrl });
  }
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
    evidence,
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
      evidence: [
        ...(Array.isArray(existing?.evidence) ? existing.evidence : []),
        ...(Array.isArray(product.evidence) ? product.evidence : []),
      ],
    });
  }
  return [...merged.values()];
}

export function extractDirectProductPage({ html, pageUrl, retailer }) {
  if (!retailer.productUrlPattern.test(pageUrl)) return null;
  const $ = load(html);
  const scope = $(".productView").first().length ? $(".productView").first() : $("main").first().length ? $("main").first() : $("body");
  const text = normalizeWhitespace(scope.text());
  const title = normalizeWhitespace(
    scope.find("h1,.productView-title").first().text() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text()
  );
  if (!title || title.length < 4) return null;

  const priceCandidate = normalizeWhitespace(
    scope.find(".price--withoutTax,.price--main,[data-product-price-without-tax],[class*=price]").first().text()
  );
  const nowPrice = text.match(/\bNow\s*(£\s*[0-9][0-9,.]*)/i)?.[1] || null;
  const pricePence = parseMoneyToPence(priceCandidate || nowPrice);
  const sku = normalizeWhitespace(
    scope.find("[data-product-sku],.productView-info-value").filter((_, node) => /[A-Z0-9-]{4,}/i.test($(node).text())).first().text()
  ) || text.match(/\b(?:Code|Ref):\s*([A-Z0-9-]{4,})/i)?.[1] || null;
  const image = scope.find("img").filter((_, node) => /product|booster|trainer|collection|tin|pack/i.test(`${$(node).attr("alt") || ""} ${$(node).attr("class") || ""}`)).first();

  return normalizeExtractedProduct({
    title,
    url: pageUrl,
    imageUrl: absoluteUrl(image.attr("src") || image.attr("data-src"), pageUrl),
    sku,
    pricePence,
    rawText: text,
    purchaseEvidence: purchaseControlEvidence($, scope),
  }, retailer, pageUrl, "product_page_probe");
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
