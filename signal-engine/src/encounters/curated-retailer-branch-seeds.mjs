// FateDrop-curated physical retailer branches.
//
// Keep this intentionally boring and auditable. A seed establishes only that a
// physical branch exists and is relevant to Local Radar. It MUST NOT claim live
// stock. Add coordinates directly when known, or a postcode that can be
// geocoded by the reconciler.
//
// Minimal shape:
// {
//   retailerId: "canonical-retailer-id",
//   branchName: "Retailer — Town",
//   address: "...",
//   postcode: "AA1 1AA",
//   sourceUrl: "https://official-or-credible-branch-source.example/...",
//   sourceType: "official_retailer_directory_snapshot" | "manual_verified_branch",
//   verification: "official_retailer_branch" | "curated_branch",
//   supportedTcgs: ["pokemon"],
// }

export const CURATED_RETAILER_BRANCH_SEEDS = Object.freeze([]);
