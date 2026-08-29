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

function localIntelIdentity(expected = {}) {
  return [
    text(expected.productIdentityId) || text(expected.title),
    text(expected.expectedFrom),
    text(expected.expectedTo),
    text(expected.expectedLabel),
    text(expected.sourceUrl) || text(expected.sourceLabel),
  ].join("|");
}

export function stableLocalIntelId(expected = {}) {
  const identity = localIntelIdentity(expected);
  if (!identity.replaceAll("|", "")) return null;
  return `local_intel_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function attachLocalIntelIds(shops = []) {
  return (Array.isArray(shops) ? shops : []).map((shop) => {
    const expected = shop?.localAvailability?.expected;
    if (!expected) return shop;
    const intelId = stableLocalIntelId(expected);
    if (!intelId) return shop;
    return {
      ...shop,
      localAvailability: {
        ...shop.localAvailability,
        expected: {
          ...expected,
          intelId,
        },
      },
    };
  });
}

export async function buildLocalRadar(options = {}) {
  const result = await buildLocalRadarBase(options);
  const shops = attachLocalIntelIds(prioritizeLocalRadarShops(result?.shops || []));
  return {
    ...result,
    shops,
    counts: {
      ...(result?.counts || {}),
      shops: shops.length,
    },
  };
}
