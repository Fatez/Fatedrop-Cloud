export const ALERT_CLASSES = Object.freeze({
  PRIMARY_DROP: "primary_drop",
  MARKET_STOCK: "market_stock",
});

const PRIMARY_DROP_RETAILERS = new Set([
  "pokemon-center-uk",
  "smyths-uk",
  "hamleys-uk",
  "asda-uk",
  "tesco-uk",
  "entertainer-uk",
  "game-uk",
  "argos-uk",
  "magic-madhouse",
]);

const MARKET_CATALOGUE_RETAILERS = new Set([
  "chaos-cards",
  "double-sleeved",
  "total-cards",
  "titan-cards",
  "eterna-cards",
  "card-collective",
  "jet-cards",
  "gathering-games",
  "zatu-games",
]);

const OFFICIAL_RRP_RETAILERS = new Set(["pokemon-center-uk"]);

export function signalCapabilities(retailerId) {
  const id = String(retailerId || "").trim();
  const dropSentinel = PRIMARY_DROP_RETAILERS.has(id);
  const marketCatalogue = MARKET_CATALOGUE_RETAILERS.has(id) || id === "magic-madhouse";
  const rrpAuthority = OFFICIAL_RRP_RETAILERS.has(id);
  return {
    dropSentinel,
    marketCatalogue,
    rrpAuthority,
    alertClass: dropSentinel ? ALERT_CLASSES.PRIMARY_DROP : ALERT_CLASSES.MARKET_STOCK,
  };
}

export function isPrimaryDropRetailer(retailerId) {
  return signalCapabilities(retailerId).dropSentinel;
}
