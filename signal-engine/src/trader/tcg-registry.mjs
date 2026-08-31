export const TCG_ACTIVATION_PHASES = Object.freeze({
  FOUNDATION: 'foundation',
  CATALOGUE_SHADOW: 'catalogue_shadow',
  BROWSE_ONLY: 'browse_only',
  MONITORING_SHADOW: 'monitoring_shadow',
  ALERTS_ENABLED: 'alerts_enabled',
});

function tcg({ code, name, shortName = name, activationPhase = TCG_ACTIVATION_PHASES.FOUNDATION, interestSelectable = true }) {
  const phaseRank = [
    TCG_ACTIVATION_PHASES.FOUNDATION,
    TCG_ACTIVATION_PHASES.CATALOGUE_SHADOW,
    TCG_ACTIVATION_PHASES.BROWSE_ONLY,
    TCG_ACTIVATION_PHASES.MONITORING_SHADOW,
    TCG_ACTIVATION_PHASES.ALERTS_ENABLED,
  ].indexOf(activationPhase);
  if (phaseRank < 0) throw new TypeError(`Unsupported TCG activation phase: ${activationPhase}`);
  return Object.freeze({
    code,
    name,
    shortName,
    activationPhase,
    interestSelectable,
    catalogueFoundation: true,
    catalogueIngestionEnabled: phaseRank >= 1,
    browseEnabled: phaseRank >= 2,
    retailerMonitoringEnabled: phaseRank >= 3,
    lifecycleAlertsEnabled: phaseRank >= 4,
  });
}

// This is a capability registry, not a claim that every listed game has a
// catalogue. Foundation entries may be selected as user interests while every
// operational path stays fail-closed until its activation phase is promoted.
const TCG_REGISTRY = Object.freeze({
  pokemon: tcg({
    code: 'pokemon',
    name: 'Pokémon Trading Card Game',
    shortName: 'Pokémon',
    activationPhase: TCG_ACTIVATION_PHASES.ALERTS_ENABLED,
  }),
  'one-piece': tcg({ code: 'one-piece', name: 'ONE PIECE CARD GAME', shortName: 'One Piece' }),
  lorcana: tcg({ code: 'lorcana', name: 'Disney Lorcana Trading Card Game', shortName: 'Lorcana' }),
  magic: tcg({ code: 'magic', name: 'Magic: The Gathering', shortName: 'Magic' }),
  yugioh: tcg({ code: 'yugioh', name: 'Yu-Gi-Oh! Trading Card Game', shortName: 'Yu-Gi-Oh!' }),
  digimon: tcg({ code: 'digimon', name: 'Digimon Card Game', shortName: 'Digimon' }),
  'flesh-and-blood': tcg({ code: 'flesh-and-blood', name: 'Flesh and Blood', shortName: 'Flesh and Blood' }),
  'star-wars-unlimited': tcg({ code: 'star-wars-unlimited', name: 'Star Wars: Unlimited', shortName: 'Star Wars' }),
  'dragon-ball-super': tcg({ code: 'dragon-ball-super', name: 'Dragon Ball Super Card Game', shortName: 'Dragon Ball' }),
  'union-arena': tcg({ code: 'union-arena', name: 'Union Arena', shortName: 'Union Arena' }),
  riftbound: tcg({ code: 'riftbound', name: 'Riftbound: League of Legends Trading Card Game', shortName: 'Riftbound' }),
});

export const SUPPORTED_TCG_CODES = Object.freeze(Object.keys(TCG_REGISTRY));

export function getTcgCapability(tcgCode) {
  const code = String(tcgCode ?? '').trim().toLowerCase();
  return TCG_REGISTRY[code] ?? null;
}

export function listPublicTcgCapabilities() {
  return SUPPORTED_TCG_CODES.map((code) => ({ ...TCG_REGISTRY[code] }));
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
