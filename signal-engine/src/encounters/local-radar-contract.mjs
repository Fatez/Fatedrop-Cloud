import crypto from "node:crypto";

import {
  buildLocalRadar as buildLocalRadarBase,
  distanceMiles,
  normalizeEncounterBatch,
} from "./local-radar.mjs";
import { prioritizeLocalRadarShops } from "./local-radar-ranking.mjs";

export { distanceMiles, normalizeEncounterBatch };

function text(value) {
  return String(value ?? "").trim();
}

export function confirmedLocalAlertId(shop = {}) {
  const confirmed = shop?.localAvailability?.confirmed;
  if (!confirmed) return null;
  const identity = [
    text(shop.id),
    text(shop.retailerId),
    text(confirmed.productIdentityId),
    text(confirmed.observedAt),
    text(confirmed.sourceUrl || confirmed.sourceLabel),
  ].join("|");
  if (!text(shop.id) || !text(confirmed.productIdentityId) || !text(confirmed.observedAt)) return null;
  return `local-confirmed-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function attachLocalAlertIds(shops = []) {
  return (Array.isArray(shops) ? shops : []).map((shop) => {
    const alertId = confirmedLocalAlertId(shop);
    if (!alertId || !shop?.localAvailability?.confirmed) return shop;
    return {
      ...shop,
      localAvailability: {
        ...shop.localAvailability,
        confirmed: {
          ...shop.localAvailability.confirmed,
          alertId,
        },
      },
    };
  });
}

export async function buildLocalRadar(options = {}) {
  const result = await buildLocalRadarBase(options);
  const shops = prioritizeLocalRadarShops(attachLocalAlertIds(result?.shops || []));
  return {
    ...result,
    shops,
    counts: {
      ...(result?.counts || {}),
      shops: shops.length,
    },
  };
}
