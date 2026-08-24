function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyRrpApplicability({ title = "", productType = "other" } = {}) {
  const text = fold(title);

  if (/\b(?:online code|code card|ptcgo|pokemon tcg live|tcg live code|digital code)\b/.test(text)) {
    return { eligible: false, reason: "digital_code" };
  }

  if (/\b(?:japanese|japan import|japanese import|korean|korea import|korean version|simplified chinese|traditional chinese|chinese simplified|chinese import)\b/.test(text)) {
    return { eligible: false, reason: "non_uk_import" };
  }

  if (/\b(?:mystery box|mystery bundle|half booster box|booster box case)\b/.test(text)
    || /\b(?:sealed\s*\+\s*acrylic case|includes high class booster box|2 booster boxes)\b/.test(text)) {
    return { eligible: false, reason: "non_standard_bundle" };
  }

  if (productType === "other" && /\b(?:single|near mint|nm|graded|psa|cgc)\b/.test(text)) {
    return { eligible: false, reason: "secondary_market_item" };
  }

  return { eligible: true, reason: null };
}
