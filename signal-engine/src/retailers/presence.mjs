// Public presence metadata is deliberately separate from monitor configuration.
// `physicalStores` means FateDrop has explicit evidence that a physical retail presence exists.
// `null` means unknown/not yet verified — never infer "online only" from absence of metadata.
const PRESENCE = Object.freeze({
  "pokemon-center-uk": { physicalStores: false },
  "smyths-uk": { physicalStores: true },
  "chaos-cards": { physicalStores: true },
  "hamleys-uk": { physicalStores: true },
  "asda-uk": { physicalStores: true },
  "tesco-uk": { physicalStores: true },
  "entertainer-uk": { physicalStores: true },
  "game-uk": { physicalStores: true },
  "argos-uk": { physicalStores: true },
  "magic-madhouse": { physicalStores: false },
  "total-cards": { physicalStores: true },
  "zatu-games": { physicalStores: false },
});

export function publicPresenceForRetailer(retailer = {}) {
  const explicitCount = Number(retailer?.physicalLocations);
  const physicalLocations = Number.isFinite(explicitCount) && explicitCount > 0
    ? Math.trunc(explicitCount)
    : null;
  const configuredPhysical = typeof retailer?.physicalStores === "boolean"
    ? retailer.physicalStores
    : null;
  const fallbackPhysical = PRESENCE[retailer?.id]?.physicalStores;
  const physicalStores = physicalLocations !== null
    ? true
    : configuredPhysical ?? (typeof fallbackPhysical === "boolean" ? fallbackPhysical : null);

  return {
    online: retailer?.online !== false,
    physicalStores,
    physicalLocations,
  };
}
