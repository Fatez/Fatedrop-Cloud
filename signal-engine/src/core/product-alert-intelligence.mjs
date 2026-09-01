const SEALED_TYPES = new Set([
  "elite_trainer_box",
  "booster_box",
  "booster_bundle",
  "booster_pack",
  "collection_box",
  "tin",
  "deck",
]);

function norm(value) {
  return String(value || "").toLowerCase().replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

function sealedSubtype(productType, title) {
  if (productType === "elite_trainer_box" || /elite trainer box|\betb\b/.test(title)) return "ETB";
  if (productType === "booster_box" || /booster (?:box|display)/.test(title)) return "BOOSTER_BOX";
  if (productType === "booster_bundle" || /booster bundle|\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten) pack bundle\b/.test(title)) return "BOOSTER_BUNDLE";
  if (productType === "collection_box" || /\bcollection\b/.test(title)) return "COLLECTION";
  if (productType === "booster_pack" || /booster pack|sleeved booster/.test(title)) return "BOOSTER_PACK";
  if (/blister/.test(title)) return "BLISTER";
  if (productType === "tin" || /\btin\b/.test(title)) return "TIN";
  if (productType === "deck" || /battle deck|theme deck|league battle deck|starter deck/.test(title)) return "DECK";
  return "SEALED_PRODUCT";
}

function accessorySubtype(title) {
  if (/sleeves?/.test(title)) return "SLEEVES";
  if (/binder|portfolio/.test(title)) return "BINDER";
  if (/deck box/.test(title)) return "DECK_BOX";
  if (/play ?mat/.test(title)) return "PLAYMAT";
  if (/top ?loader|card protector/.test(title)) return "CARD_PROTECTION";
  if (/dice|counter|token/.test(title)) return "GAME_ACCESSORY";
  if (/storage box|card stand/.test(title)) return "STORAGE";
  return "ACCESSORY";
}

function merchandiseSubtype(title) {
  if (/blind box/.test(title)) return "BLIND_BOX";
  if (/fridge magnet|\bmagnet\b/.test(title)) return "MAGNET";
  if (/backpack|rucksack|\bbag\b/.test(title)) return "BAG";
  if (/journal|notebook/.test(title)) return "STATIONERY";
  if (/\bpin\b|pin badge/.test(title)) return "PIN";
  if (/plush|soft toy/.test(title)) return "PLUSH";
  if (/figure|figurine|statue/.test(title)) return "FIGURE";
  if (/hoodie|t-?shirt|shirt|jersey|clothing|apparel|\bcap\b|\bhat\b/.test(title)) return "APPAREL";
  if (/mug|bottle|tumbler/.test(title)) return "DRINKWARE";
  if (/key ?ring|keychain|key chain|lanyard/.test(title)) return "SMALL_MERCH";
  if (/poster|print/.test(title)) return "PRINT";
  return "MERCHANDISE";
}

export function classifyProductAlert({ title: rawTitle = "", productType: rawProductType = "" } = {}) {
  const title = norm(rawTitle);
  const productType = norm(rawProductType).replace(/\s+/g, "_");

  const accessoryEvidence = /sleeves?|binder|portfolio|deck box|play ?mat|top ?loader|card protector|dice|counter|token|storage box|card stand/.test(title);
  const merchandiseEvidence = /blind box|fridge magnet|\bmagnet\b|backpack|rucksack|\bbag\b|journal|notebook|\bpin\b|pin badge|plush|soft toy|figure|figurine|statue|hoodie|t-?shirt|shirt|jersey|clothing|apparel|\bcap\b|\bhat\b|mug|bottle|tumbler|key ?ring|keychain|key chain|lanyard|poster|print/.test(title);
  const sealedMultiPackEvidence = /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten) pack bundle\b/.test(title)
    && !accessoryEvidence
    && !merchandiseEvidence;
  const strongSealedEvidence = /elite trainer box|\betb\b|booster (?:box|display|bundle|pack)|sleeved booster|blister|build\s*(?:&|and)\s*battle|trainer toolkit|battle deck|theme deck|league battle deck|starter deck|\btin\b/.test(title)
    || sealedMultiPackEvidence;
  const tcgCollectionEvidence = /\btcg\b.*\bcollection\b|\bcollection\b.*\btcg\b/.test(title);
  const singleCardEvidence = /\bsingle card\b|\bindividual card\b|\bpromo card\b|\bpromo\b.*\bcard\b|reverse holo|holo rare|illustration rare|special illustration rare|secret rare|full art card|near mint|light play|lightly played/.test(title);

  if (strongSealedEvidence || tcgCollectionEvidence || (productType === "collection_box" && !accessoryEvidence && !merchandiseEvidence)) {
    return {
      category: "SEALED_TCG",
      subcategory: sealedSubtype(productType, title),
      confidence: strongSealedEvidence || tcgCollectionEvidence ? 0.99 : 0.94,
      evidence: [
        strongSealedEvidence ? "sealed-title-structure" : null,
        tcgCollectionEvidence ? "tcg-collection-title" : null,
        productType ? `product-type:${productType}` : null,
      ].filter(Boolean),
    };
  }

  if (merchandiseEvidence) {
    return {
      category: "MERCHANDISE",
      subcategory: merchandiseSubtype(title),
      confidence: 0.98,
      evidence: ["merchandise-title-structure", productType ? `product-type:${productType}` : null].filter(Boolean),
    };
  }

  if (accessoryEvidence || productType === "accessory") {
    return {
      category: "ACCESSORY",
      subcategory: accessorySubtype(title),
      confidence: accessoryEvidence ? 0.98 : 0.92,
      evidence: [accessoryEvidence ? "accessory-title-structure" : "accessory-product-type", productType ? `product-type:${productType}` : null].filter(Boolean),
    };
  }

  if (SEALED_TYPES.has(productType)) {
    return {
      category: "SEALED_TCG",
      subcategory: sealedSubtype(productType, title),
      confidence: 0.97,
      evidence: [`product-type:${productType}`],
    };
  }

  if (singleCardEvidence || ["single_card", "card_single", "single"].includes(productType)) {
    return {
      category: "SINGLE_CARD",
      subcategory: /promo/.test(title) ? "PROMO" : "SINGLE",
      confidence: singleCardEvidence ? 0.96 : 0.9,
      evidence: [singleCardEvidence ? "single-card-title-structure" : "single-card-product-type"],
    };
  }

  return {
    category: "UNKNOWN",
    subcategory: "UNCLASSIFIED",
    confidence: 0.4,
    evidence: [productType ? `unresolved-product-type:${productType}` : "no-reliable-product-type"],
  };
}

export function isBetaAlertEligible(input) {
  return classifyProductAlert(input).category === "SEALED_TCG";
}
