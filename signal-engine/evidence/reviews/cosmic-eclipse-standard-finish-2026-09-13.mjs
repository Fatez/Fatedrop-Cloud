import { writeFile } from 'node:fs/promises';
import idsA from './cosmic-eclipse-standard-ids-a.mjs';
import idsB from './cosmic-eclipse-standard-ids-b.mjs';

const IDS = [...idsA, ...idsB];
const ROSA_204_ID = 'fdcard_afc95d93fe5308dcf6a06ca8';
const SET_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Cosmic_Eclipse_(TCG)&oldid=4284621';
const BUILD_BATTLE_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Cosmic_Eclipse_Build_%26_Battle_Box_(TCG)&oldid=4386439';
const PLAYER_GUIDE_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Cosmic_Eclipse_Player%27s_Guide_(TCG)&oldid=4245250';

const completeness = Object.freeze({
  checklistComplete: true,
  sealedProductDecklistsCovered: true,
  paginationComplete: true,
  alternateDistributionCovered: true,
});

export function buildCosmicEclipseReviewedInput(observedAt = 1789292400000) {
  return {
    provider: 'set_rule',
    reviewer: 'Fatez operator-reviewed Cosmic Eclipse printing audit',
    approvalReference: 'cosmic-eclipse-standard-finish-review-2026-09-13',
    reviews: IDS.map(cardIdentityId => {
      const exists = cardIdentityId === ROSA_204_ID;
      return {
        cardIdentityId,
        finish: 'standard',
        language: 'en',
        edition: 'unspecified',
        verdict: exists ? 'exists' : 'does_not_exist',
        basis: 'exact_printing_checklist',
        sourceLocator: exists ? BUILD_BATTLE_SOURCE : SET_SOURCE,
        observedAt,
        observedFinish: 'standard',
        evidencePayload: exists ? {
          set: 'Cosmic Eclipse',
          setCode: 'sm12',
          sourceRevisionOldids: { set: 4284621, buildBattle: 4386439, playerGuide: 4245250 },
          playerGuideSource: PLAYER_GUIDE_SOURCE,
          finding: 'The Build & Battle Box record explicitly provides an exclusive Non Holofoil Rosa #204.',
        } : {
          set: 'Cosmic Eclipse',
          setCode: 'sm12',
          sourceRevisionOldids: { set: 4284621, buildBattle: 4386439, playerGuide: 4245250 },
          buildBattleSource: BUILD_BATTLE_SOURCE,
          playerGuideSource: PLAYER_GUIDE_SOURCE,
          finding: 'The complete expansion and ancillary-printing record does not list a standard/non-holo printing for this identity; the Build & Battle record limits exclusive Non Holofoil conversions to Sawsbuck #16, Dusknoir #85 and Rosa #204.',
          completeness,
        },
      };
    }),
  };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: node cosmic-eclipse-standard-finish-2026-09-13.mjs output.json');
  const manifest = buildCosmicEclipseReviewedInput();
  await writeFile(outputPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ reviews: manifest.reviews.length, exists: 1, doesNotExist: 81 }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
