import { writeFile } from 'node:fs/promises';

const IDS = [
  'fdcard_9c88de1a3f6d7c65ae058045',
  'fdcard_3dd0734cde130b66b86d8cc9',
  'fdcard_ce62add71241d4bae42fb896',
  'fdcard_6ea057aff36a602c00202481',
  'fdcard_e22d9283a3d478f54c539010',
  'fdcard_902e4067b8a9fe5ec58ec12a',
  'fdcard_76772c2c02ec4630e84db095',
  'fdcard_e50ace73b041e04cf275486c',
  'fdcard_b55a1d942760458b3058f7d5',
  'fdcard_c46ee54f55e09d7af52ce71a',
  'fdcard_754988e4976554e67181c0b9',
  'fdcard_ad555f1591900ae41666953e',
  'fdcard_1bf5e9b3722a0a91fc1c188a',
  'fdcard_78e52fd5791e8032292ac6cf',
  'fdcard_906a6dbc20fe95bf537a7b33',
  'fdcard_3585fde34feff391a09f381c',
  'fdcard_6fd5d311e7b4dc8255fa4c78',
  'fdcard_7dad62b7472b1fadc669cba2',
  'fdcard_ba1c475802b03e65061b495b',
  'fdcard_c07fefa14c1405e195f7ae61',
  'fdcard_6fd5167587aa09770f93cd9e',
  'fdcard_54a3cb1e53b60f6b27f3bf0b',
  'fdcard_bc6be5a7cff197b0e74bd2fe',
  'fdcard_1710e8fa4da9d09445e68b75',
  'fdcard_52ada815d7a1d5a32e65d8e2',
  'fdcard_1d23986b1d2352964fe699e6',
  'fdcard_e32010d17bfe956269e832e0',
  'fdcard_59fb918d94b58ea3347914d1',
  'fdcard_33dd1485e320bbb3e36dfd99',
  'fdcard_7de73e7378437bc6c42a9f25',
  'fdcard_c909f89d9def08513d4127b3',
  'fdcard_cff9b9c8eef38596576c2226',
  'fdcard_dde2bd279aa85ff4dc701c78',
  'fdcard_3ccfe7a7d9065c3fde2738ee',
  'fdcard_cb0cc67e9c7c1c7aa5029513',
  'fdcard_22bf8a73dd2c2e1dd79762f4',
  'fdcard_87b82eefa4bce853dc30006c',
  'fdcard_7bcb2807533cb3e2b5553cf5',
  'fdcard_f765a7d3cee2ac4171174900',
  'fdcard_5a32d2a1f77d671009a721da',
  'fdcard_be8f72b1adbd3aeeb537a7ad',
  'fdcard_fa2334834de9a56852bd29c7',
  'fdcard_6fc00b5fe3bfb7f9ef5f9fea',
  'fdcard_71de5a4a0f8bf83dc70f4ce2',
  'fdcard_7a8574e04797d7d56140292e',
  'fdcard_68d0bc68c7bb0c7377bbb201',
  'fdcard_a0edec3940f82857179fc8ba',
  'fdcard_d8ba266015cb289aa44ddc8d',
  'fdcard_45df9a1b7eac2740b398c5fa',
  'fdcard_afa9042f9baea9ffaf0323ee',
  'fdcard_6af648bad5729737709408c0',
  'fdcard_f4f5655b1b4f926cc31912b0',
  'fdcard_4703e0a1d55769d4210d4196',
  'fdcard_b91214894c10183e51d3cf62',
  'fdcard_3178a0b4fd99d5922a9cc517',
  'fdcard_64ca5dba9f58e35ee8c1f92e',
  'fdcard_13e54850a4cb00b599e92ddd',
  'fdcard_4117634daa4b77ed4e703a03',
  'fdcard_529a35805741fca4f21c445e',
  'fdcard_c0f1b405296f280074f25c7e',
];

const HOOPA_140_ID = 'fdcard_ad555f1591900ae41666953e';
const EXISTS_IDS = new Set([HOOPA_140_ID]);

const SET_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Unified_Minds_(TCG)&oldid=4193154';
const BUILD_BATTLE_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Unified_Minds_Build_%26_Battle_Box_(TCG)&oldid=4380723';
const LEAGUE_DECK_SOURCE = 'https://bulbapedia.bulbagarden.net/w/index.php?title=Pikachu_%26_Zekrom-GX_League_Battle_Deck_(TCG)&oldid=3943876';
const TPCI_CHECKLIST_SOURCE = 'https://www.pokemon.com/static-assets/content-assets/cms2-en-uk/pdf/trading-card-game/checklist/sm11_web_cardlist_en.pdf';

const completeness = Object.freeze({
  checklistComplete: true,
  sealedProductDecklistsCovered: true,
  paginationComplete: true,
  alternateDistributionCovered: true,
});

export function buildUnifiedMindsReviewedInput(observedAt = 1789299600000) {
  return {
    provider: 'set_rule',
    reviewer: 'Fatez operator-reviewed Unified Minds printing audit',
    approvalReference: 'unified-minds-standard-finish-review-2026-09-13',
    reviews: IDS.map(cardIdentityId => {
      const exists = EXISTS_IDS.has(cardIdentityId);
      let sourceLocator = SET_SOURCE;
      let finding;
      if (cardIdentityId === HOOPA_140_ID) {
        sourceLocator = LEAGUE_DECK_SOURCE;
        finding = 'The Pikachu & Zekrom-GX League Battle Deck record explicitly lists an exclusive Non Holofoil print of Unified Minds Hoopa #140.';
      } else {
        finding = 'The official TPCi checklist establishes the English set identity; the pinned Unified Minds ancillary-printing ledger plus Build & Battle and League Battle Deck documentation enumerate known alternate product printings, with no standard/non-holo printing recorded for this exact identity.';
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
          set: 'Unified Minds',
          setCode: 'sm11',
          sourceRevisionOldids: { set: 4193154, buildBattle: 4380723, leagueDeck: 3943876 },
          officialChecklistSource: TPCI_CHECKLIST_SOURCE,
          ancillaryPrintingSource: SET_SOURCE,
          buildBattleSource: BUILD_BATTLE_SOURCE,
          leagueBattleDeckSource: LEAGUE_DECK_SOURCE,
          finding,
          ...(exists ? {} : { completeness }),
        },
      };
    }),
  };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: node unified-minds-standard-finish-2026-09-13.mjs output.json');
  const manifest = buildUnifiedMindsReviewedInput();
  await writeFile(outputPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ reviews: manifest.reviews.length, exists: 1, doesNotExist: 59 }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
