import { canonicalKey, productTypeFromTitle } from "../core/normalize.mjs";

function moneyStringToPence(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

export function normalizeShopifyProducts(payload, retailer) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const output = [];
  for (const product of products) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    for (const variant of variants) {
      const title = String(product?.title || "").trim();
      const retailerSku = String(variant?.sku || variant?.id || "").trim();
      if (!title || !retailerSku || !product?.handle) continue;
      const variantTitle = variant?.title && variant.title !== "Default Title" ? `${title} — ${variant.title}` : title;
      const productType = productTypeFromTitle(variantTitle);
      output.push({
        retailerSku,
        title: variantTitle,
        url: new URL(`/products/${product.handle}${variant?.id ? `?variant=${variant.id}` : ""}`, retailer.baseUrl).toString(),
        imageUrl: product?.images?.[0]?.src || product?.image?.src || null,
        pricePence: moneyStringToPence(variant?.price),
        postagePence: null,
        productType,
        canonicalKey: canonicalKey(variantTitle, productType),
        stockStatus: variant?.available === true ? "in_stock" : variant?.available === false ? "out_of_stock" : "unknown",
        stockConfidence: variant?.available === true || variant?.available === false ? 0.98 : 0.5,
        stockQuantity: null,
        evidence: [{ kind: "shopify_structured_catalogue", value: `variant:${variant?.id || retailerSku}` }],
      });
    }
  }
  return output;
}
