const TCG_REGISTRY = Object.freeze({
  pokemon: Object.freeze({
    code: 'pokemon',
    name: 'Pokémon Trading Card Game',
    catalogueFoundation: true,
    catalogueIngestionEnabled: true,
    retailerMonitoringEnabled: true,
    lifecycleAlertsEnabled: true,
  }),
  'one-piece': Object.freeze({
    code: 'one-piece',
    name: 'ONE PIECE CARD GAME',
    catalogueFoundation: true,
    catalogueIngestionEnabled: false,
    retailerMonitoringEnabled: false,
    lifecycleAlertsEnabled: false,
  }),
});

export const SUPPORTED_TCG_CODES = Object.freeze(Object.keys(TCG_REGISTRY));

export function getTcgCapability(tcgCode) {
  const code = String(tcgCode ?? '').trim().toLowerCase();
  return TCG_REGISTRY[code] ?? null;
}

export function requireKnownTcg(tcgCode) {
  const capability = getTcgCapability(tcgCode);
  if (!capability) throw new TypeError(`Unsupported TCG code: ${String(tcgCode ?? '').trim() || 'missing'}`);
  return capability;
}

export function canIngestTcgCatalogue(tcgCode) {
  return getTcgCapability(tcgCode)?.catalogueIngestionEnabled === true;
}

export function canMonitorTcgRetailers(tcgCode) {
  return getTcgCapability(tcgCode)?.retailerMonitoringEnabled === true;
}

export function canEmitTcgLifecycleAlerts(tcgCode) {
  return getTcgCapability(tcgCode)?.lifecycleAlertsEnabled === true;
}
