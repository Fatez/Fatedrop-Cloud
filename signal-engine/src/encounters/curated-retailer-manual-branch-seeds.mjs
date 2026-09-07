import { SMYTHS_FINAL_BRANCH_ROWS } from "./final-branch-data/smyths.mjs";
import { HAMLEYS_FINAL_BRANCH_ROWS } from "./final-branch-data/hamleys.mjs";
import { ENTERTAINER_FINAL_BRANCH_ROWS } from "./final-branch-data/entertainer.mjs";
import { GAME_FINAL_BRANCH_ROWS } from "./final-branch-data/game.mjs";
import { TESCO_FINAL_BRANCH_ROWS } from "./final-branch-data/tesco.mjs";
import { ASDA_FINAL_BRANCH_ROWS } from "./final-branch-data/asda.mjs";
import { BM_FINAL_BRANCH_ROWS } from "./final-branch-data/bm.mjs";

// FateDrop final curated UK physical retailer branch database.
// Source: user-supplied final CSV imported on 2026-08-30.
// Branch presence only. Source stock/status fields are intentionally excluded.
const SOURCE_TYPE = "fatedrop_curated_branch_database";
const SOURCE_ATTRIBUTION = "FateDrop curated UK physical retailer branch database";
const SOURCE_OBSERVED_AT = "2026-08-30T00:41:41+01:00";

export const CURATED_MANUAL_RETAILER_REGISTRY_SEEDS = Object.freeze([
  Object.freeze({
    id: "bm-stores-uk",
    name: "B&M",
    websiteUrl: "https://www.bmstores.co.uk/",
    retailerClass: "national",
    adapterType: "manual",
    state: "paused",
    verification: "pending",
    rrpAuthority: "none",
    tcgs: ["pokemon"],
    online: false,
    physicalLocations: 35,
    discovery: {
      source: SOURCE_TYPE,
      discoveredAt: SOURCE_OBSERVED_AT,
      evidence: [{ type: "curated_physical_branch_database", source: "final_uk_physical_retailer_csv" }],
    },
  }),
]);

const RETAILER_BRANCH_GROUPS = Object.freeze([
  Object.freeze({ retailerId: "smyths-uk", brand: "Smyths Toys", rows: SMYTHS_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "hamleys-uk", brand: "Hamleys", rows: HAMLEYS_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "entertainer-uk", brand: "The Entertainer", rows: ENTERTAINER_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "game-uk", brand: "GAME", rows: GAME_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "tesco-uk", brand: "Tesco Extra", rows: TESCO_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "asda-uk", brand: "ASDA", rows: ASDA_FINAL_BRANCH_ROWS }),
  Object.freeze({ retailerId: "bm-stores-uk", brand: "B&M", rows: BM_FINAL_BRANCH_ROWS }),
]);

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export const CURATED_MANUAL_RETAILER_BRANCH_SEEDS = Object.freeze(
  RETAILER_BRANCH_GROUPS.flatMap(({ retailerId, brand, rows }) => rows.map(([branch, city, postcode, country]) => Object.freeze({
    retailerId,
    branchName: `${brand} — ${branch}`,
    branchKey: `${retailerId}:${postcodeKey(postcode).toLowerCase()}`,
    address: [branch, city, postcode, country].filter(Boolean).join(", "),
    postcode,
    sourceType: SOURCE_TYPE,
    sourceAttribution: SOURCE_ATTRIBUTION,
    sourceObservedAt: SOURCE_OBSERVED_AT,
    verification: "curated_branch",
    supportedTcgs: ["pokemon"],
    notes: "Branch identity only; stock remains unknown.",
  }))),
);
