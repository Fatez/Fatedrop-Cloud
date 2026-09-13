import { writeFile } from 'node:fs/promises';

const IDS = [
  'fdcard_218824cdfebc4714fe32fa32',
  'fdcard_f2d1b73953941c20c9d719f1',
  'fdcard_7c7ecab069c61d8803de7ade',
  'fdcard_a5de4d736622b2fb1be1a665',
  'fdcard_be24d5da51e6e1a7f524fa43',
  'fdcard_c8d11b7207a54a9ff190283f',
  'fdcard_2486e10593341dc044e9e2b5',
  'fdcard_7f37b2a0dcd541690d588b32',
  'fdcard_190336ced19fc6571d8e35cb',
  'fdcard_6dc039456365717ab9936b71',
  'fdcard_e004885a264082aebd9a26c1',
  'fdcard_f3d3fe9d0d2667885ba8a5d8',
  'fdcard_e4eeef3d343aabe3acfecb38',
  'fdcard_fc9e95dc6d207ee90780ff4b',
  'fdcard_60fda3d5df55328cfc8711c5',
  'fdcard_62e86381e394cf294980a098',
  'fdcard_9e3f91ff2d840d58370a638a',
  'fdcard_7ee0d5f4cd6edab83ebd155e',
  'fdcard_6a14cc8b6a839cd0af98cefd',
  'fdcard_417c1420321f18552c470b36',
  'fdcard_7873187c6ad54a7f69021355',
  'fdcard_f30e78e8546ea252411868ab',
  'fdcard_39e5cb322b4f722af915e639',
  'fdcard_98863d5461fe76df455f8b32',
  'fdcard_abcdbcfc1905f1d53ceaf137',
  'fdcard_939bfd8a05da5fcc6afd0d59',
  'fdcard_85c93633ac6a2cb4603057aa',
  'fdcard_5325dfcb5d33f524d81c1cd5',
  'fdcard_931615c36f2b2511c6cb0a1f',
  'fdcard_f97012bab74d9664f3d584e9',
  'fdcard_64f681101d95d376bc4818b9',
  'fdcard_6ad0ad4c7e5c6970c2994f6d',
  'fdcard_a4d591a05fb83e1dfa594d7f',
  'fdcard_91865dcf4356bde63041665d',
  'fdcard_af13d91a838e7dc46b7944c4',
  'fdcard_97000e848a040c26feafd88d',
  'fdcard_9726009255ad6ea8be4101b4',
  'fdcard_b8ca4d9f1ceffb5b0a2200a7',
  'fdcard_98685197262070c620c85d42',
  'fdcard_758d144bebb8a46684b68360',
  'fdcard_743de02d38c3d39147f46a12',
  'fdcard_100cdc8458a3febf216a9402',
  'fdcard_d4d43073ba3bd64ad6fa4d83',
  'fdcard_ac2b083e4560ddf664ce1383',
  'fdcard_15315425e280a8d1a9280763',
  'fdcard_2dd8ea0e5c04b9b7222369ed',
  'fdcard_7f627857e767913f4dff1e8e',
  'fdcard_80560f81a789f6613973de66',
  'fdcard_1b1990490d4ce7b504a9ebf9',
  'fdcard_bc74d27d5f9db52fee328d02',
  'fdcard_369aae9ca6a34af6f0977b58',
  'fdcard_16517cb67c58daa1c1494969',
  'fdcard_32807e082cc4fd819d36eae4',
  'fdcard_35d5fb4cbb83784d42659784',
  'fdcard_87eb9290953f685de88d6f96',
  'fdcard_8201a4c2f6f47bbc34368a90',
  'fdcard_54c6db6a60a4845f1eb25ce6',
  'fdcard_927ae875dbafe0d50c5343b7',
  'fdcard_d5cb8cfe4f723cdfa3f4ad2d',
  'fdcard_48edf31bd9c2b4460e2d5d94',
  'fdcard_6e57ba4eb8e7b8e5a9a6d5dc',
];

const MEW_76_ID = 'fdcard_2486e10593341dc044e9e2b5';
const REDS_CHALLENGE_184_ID = 'fdcard_9e3f91ff2d840d58370a638a';
const EXISTS_IDS = new Set([MEW_76_ID, REDS_CHALLENGE_184_ID]);

const SET_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Unbroken_Bonds_(TCG)&oldid=4193206';
const BUILD_BATTLE_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Unbroken_Bonds_Build_%26_Battle_Box_(TCG)&oldid=4380446';
const TPCI_CHECKLIST_SOURCE = 'https://www.pokemon.com/static-assets/content-assets/cms2-en-uk/pdf/trading-card-game/checklist/sm10_web_cardlist_en.pdf';

const completeness = Object.freeze({
  checklistComplete: true,
  sealedProductDecklistsCovered: true,
  paginationComplete: true,
  alternateDistributionCovered: true,
});

export function buildUnbrokenBondsReviewedInput(observedAt = 1789297200000) {
  return {
    provider: 'set_rule',
    reviewer: 'Fatez operator-reviewed Unbroken Bonds printing audit',
    approvalReference: 'unbroken-bonds-standard-finish-review-2026-09-13',
    reviews: IDS.map(cardIdentityId => {
      const exists = EXISTS_IDS.has(cardIdentityId);
      let sourceLocator = SET_SOURCE;
      let finding;
      if (cardIdentityId === MEW_76_ID) {
        finding = 'The expansion ancillary-printing ledger explicitly records Mew #76 as a Non Holo Towering Heights Theme Deck exclusive.';
      } else if (cardIdentityId === REDS_CHALLENGE_184_ID) {
        sourceLocator = BUILD_BATTLE_SOURCE;
        finding = 'The Build & Battle Box record explicitly identifies Red’s Challenge #184 as an exclusive Non Holofoil printing and lists it in the Persian evolution group.';
      } else {
        finding = 'The TPCi set checklist establishes the English set identity and the pinned expansion ancillary-printing ledger enumerates known alternate product printings; no standard/non-holo printing is recorded for this exact identity.';
      }
      return {
        cardIdentityId,
        finish: 'standard',
        language: 'en',
        edition: 'unspecified',
        verdict: exists ? 'exists' : 'does_not_exist',
        basis: 'exact_printing_checklist',
        sourceLocator,
        observedAt,
        observedFinish: 'standard',
        evidencePayload: {
          set: 'Unbroken Bonds',
          setCode: 'sm10',
          sourceRevisionOldids: { set: 4193206, buildBattle: 4380446 },
          officialChecklistSource: TPCI_CHECKLIST_SOURCE,
          ancillaryPrintingSource: SET_SOURCE,
          buildBattleSource: BUILD_BATTLE_SOURCE,
          finding,
          ...(exists ? {} : { completeness }),
        },
      };
    }),
  };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: node unbroken-bonds-standard-finish-2026-09-13.mjs output.json');
  const manifest = buildUnbrokenBondsReviewedInput();
  await writeFile(outputPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ reviews: manifest.reviews.length, exists: 2, doesNotExist: 59 }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
