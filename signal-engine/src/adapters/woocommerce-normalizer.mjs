import { canonicalKey, productTypeFromTitle } from "../core/normalize.mjs";

function wooMoneyToPence(prices = {}) {
  const raw = prices.price;
  const minor = Number.isFinite(Number(prices.currency_minor_unit)) ? Number(prices.currency_minor_unit) : 2;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return minor === 2 ? Math.round(value) : Math.round(value * (100 / (10 ** minor)));
}

export function normalizeWooStoreProducts(payload, retailer) {
  const products = Array.isArray(payload) ? payload : [];
  return products.flatMap((product) => {
    const title = String(product?.name || "").trim();
    const retailerSku = String(product?.sku || product?.id || "").trim();
    const permalink = String(product?.permalink || "").trim();
    if (!title || !retailerSku || !permalink) return [];
    const productType = productTypeFromTitle(title);
    const stockStatus = product?.is_in_stock === true ? "in_stock" : product?.is_in_stock === false ? "out_of_stock" : "unknown";
    return [{
      retailerSku,
      title,
      url: permalink,
      imageUrl: product?.images?.[0]?.src || null,
      pricePence: wooMoneyToPence(product?.prices),
      postagePence: null,
      productType,
      canonicalKey: canonicalKey(title, productType),
      stockStatus,
      stockConfidence: stockStatus === "unknown" ? 0.5 : 0.98,
      stockQuantity: null,
      evidence: [
        { kind: "woocommerce_store_api", value: `product:${product?.id || retailerSku}` },
        ...(product?.is_in_stock === true ? [{ kind: "verified_stock_api", value: "woocommerce_is_in_stock" }] : []),
      ],
    }];
  });
}
