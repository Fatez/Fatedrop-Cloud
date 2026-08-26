function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function absoluteUrl(value, base = "https://www.pokemoncenter.com") {
  const raw = text(value);
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function numericValue(value) {
  const candidate = firstValue(value);
  if (candidate == null) return null;
  if (typeof candidate === "object") {
    return numericValue(candidate.value ?? candidate.amount ?? candidate.price ?? null);
  }
  if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
  const normalized = String(candidate).replace(/[^0-9.-]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function priceToPence(value) {
  const number = numericValue(value);
  return number == null ? null : Math.round(number * 100);
}

export function mapAvailability(value) {
  const raw = text(firstValue(value)).toUpperCase().replace(/[\s-]+/g, "_");
  if (["IN_STOCK", "AVAILABLE", "ONLINE_ONLY"].includes(raw)) return "in_stock";
  if (["LOW_STOCK", "LIMITED_STOCK"].includes(raw)) return "low_stock";
  if (["OUT_OF_STOCK", "SOLD_OUT", "UNAVAILABLE", "NOT_AVAILABLE"].includes(raw)) return "out_of_stock";
  if (["PREORDER", "PRE_ORDER"].includes(raw)) return "preorder";
  if (["COMING_SOON", "COMINGSOON"].includes(raw)) return "coming_soon";
  return "unknown";
}

export function mapPokemonCenterDoc(raw) {
  if (!raw || typeof raw !== "object") return null;

  const sku = text(raw.pid);
  const title = text(raw.title || raw.reporting_product_name);
  const url = absoluteUrl(raw.url);
  if (!sku || !title || !url) return null;

  const availabilityRaw = firstValue(raw.availability_status);
  const mappedAvailability = mapAvailability(availabilityRaw);
  const launchDate = text(raw.launch_date) || null;
  const imageUrl = absoluteUrl(raw.primary_image_full_size || raw.primary_image || raw.thumb_image);
  const stockQuantity = numericValue(raw.stock_quantity ?? raw.inventory_quantity ?? raw.inventory ?? raw.ats);
  const sellingPricePence = priceToPence(raw.sale_price ?? raw.price);
  const officialRrpPence = priceToPence(raw.list_price ?? raw.regular_price ?? raw.price ?? raw.sale_price);

  const evidence = [
    { kind: "pokemon_center_search_api", value: `availability_status:${text(availabilityRaw) || "UNKNOWN"}` },
    // The browser collector only emits mapped products from Pokémon Center's
    // own structured catalogue and canonical en-gb product URLs. This proves
    // official retailer-page publication/readiness, but not Add-to-Cart.
    { kind: "official_retailer_product_page", value: url },
  ];
  if (launchDate) {
    evidence.push({ kind: "pokemon_center_launch_date", value: launchDate });
    evidence.push({ kind: "launch_date", value: launchDate });
  }
  if (mappedAvailability === "preorder") evidence.push({ kind: "preorder_metadata", value: "pokemon_center_catalogue_preorder" });
  if (officialRrpPence != null) evidence.push({ kind: "pokemon_center_official_rrp", value: String(officialRrpPence) });

  return {
    retailerSku: sku,
    title,
    url,
    imageUrl,
    pricePence: sellingPricePence,
    officialRrpPence,
    stockStatus: mappedAvailability,
    stockConfidence: 0.99,
    stockQuantity: Number.isFinite(stockQuantity) ? Math.round(stockQuantity) : null,
    evidence,
  };
}
