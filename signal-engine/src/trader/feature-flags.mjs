function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function resolveFateTraderFlags(source = process.env) {
  const master = enabled(source.FATE_TRADER_ENABLED);
  const catalogue = master && enabled(source.FATE_TRADER_CATALOGUE_ENABLED);
  const collection = catalogue && enabled(source.FATE_TRADER_COLLECTION_ENABLED);
  const network = collection && enabled(source.FATE_TRADER_NETWORK_ENABLED);
  const matching = network && enabled(source.FATE_TRADER_MATCHING_ENABLED);
  const hunts = matching && enabled(source.FATE_TRADER_HUNTS_ENABLED);
  const messaging = network && enabled(source.FATE_TRADER_MESSAGING_ENABLED);

  return Object.freeze({
    enabled: master,
    catalogueEnabled: catalogue,
    collectionEnabled: collection,
    networkEnabled: network,
    matchingEnabled: matching,
    huntsEnabled: hunts,
    messagingEnabled: messaging,
  });
}
