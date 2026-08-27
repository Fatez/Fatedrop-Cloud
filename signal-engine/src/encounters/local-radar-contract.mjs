import {
  buildLocalRadar as buildLocalRadarBase,
  distanceMiles,
  normalizeEncounterBatch,
} from "./local-radar.mjs";
import { prioritizeLocalRadarShops } from "./local-radar-ranking.mjs";

export { distanceMiles, normalizeEncounterBatch };

export async function buildLocalRadar(options = {}) {
  const result = await buildLocalRadarBase(options);
  const shops = prioritizeLocalRadarShops(result?.shops || []);
  return {
    ...result,
    shops,
    counts: {
      ...(result?.counts || {}),
      shops: shops.length,
    },
  };
}
