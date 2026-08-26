import { scanRetailerSource } from "../adapters/index.mjs";
import { shouldPublishCatalogue } from "./onboarding.mjs";
import { retailerToAdapterConfig } from "./runtime.mjs";

const SEALED_SHAPE = /booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|battle academy|trainer toolkit|build\s*&\s*battle|premium|bundle|display|box\b|pack\b|poster|mini portfolio|ultra premium/i;
const NON_TARGET = /\bsingle\b|code card|sleeve|binder(?: only)?|playmat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b/i;
const POKEMON_NAMED = /pok[eé]mon/i;

function catalogueLooksPokemonScoped(retailer) {
  return [retailer?.catalogue?.feedUrl, ...(retailer?.catalogue?.urls || [])]
    .filter(Boolean)
    .some((value) => /pokemon|scarlet|violet|sv\d+/i.test(String(value)));
}

function relevanceSummary(retailer, products) {
  const pokemonScoped = catalogueLooksPokemonScoped(retailer);
  let pokemonNamed = 0;
  let sealedShaped = 0;
  let likelyPokemonSealed = 0;
  let likelySinglesOrAccessories = 0;
  for (const row of products) {
    const value = String(row?.title || "");
    const namedPokemon = POKEMON_NAMED.test(value);
    const shapedSealed = SEALED_SHAPE.test(value) && !NON_TARGET.test(value);
    if (namedPokemon) pokemonNamed += 1;
    if (shapedSealed) sealedShaped += 1;
    if (shapedSealed && (namedPokemon || pokemonScoped)) likelyPokemonSealed += 1;
    if (NON_TARGET.test(value)) likelySinglesOrAccessories += 1;
  }
  return {
    pokemonScoped,
    pokemonNamed,
    sealedShaped,
    likelyPokemonSealed,
    likelySinglesOrAccessories,
    likelyPokemonSealedCoverage: products.length ? likelyPokemonSealed / products.length : 0,
  };
}

export function summariseDryRun({ retailer, products = [], pages = [], previousCompleteCount = null, explicitlyComplete = true } = {}) {
  const total = products.length;
  const withPrice = products.filter((row) => Number.isFinite(row.pricePence)).length;
  const knownStock = products.filter((row) => row.stockStatus && row.stockStatus !== "unknown").length;
  const unknownStock = total - knownStock;
  const stockCoverage = total ? knownStock / total : 0;
  const priceCoverage = total ? withPrice / total : 0;
  const completeness = shouldPublishCatalogue({
    previousCompleteCount,
    observedCount: total,
    expectedMinimumProducts: retailer?.monitoring?.expectedMinimumProducts ?? null,
    explicitlyComplete: explicitlyComplete === true,
  });
  return {
    retailerId: retailer?.id || null,
    productsObserved: total,
    pagesScanned: pages.length,
    priceCoverage,
    stockCoverage,
    unknownStock,
    catalogueComplete: completeness.publish,
    completenessReason: completeness.reason,
    adapterQualified: total > 0,
    dryRunComplete: total > 0,
    stockMappingValidated: total > 0 && stockCoverage >= 0.8,
    relevance: relevanceSummary(retailer, products),
    sample: products.slice(0, 5).map((row) => ({ title: row.title, pricePence: row.pricePence, stockStatus: row.stockStatus, url: row.url })),
  };
}

export async function dryRunRetailer(input, { previousCompleteCount = null, scanSource = scanRetailerSource } = {}) {
  const retailer = retailerToAdapterConfig(input, { requireMonitored: false, allowUnapprovedFeed: true });
  const { products, pages, complete } = await scanSource(retailer, { allowUnapprovedFeed: true });
  return {
    retailer,
    diagnostics: summariseDryRun({
      retailer,
      products,
      pages,
      previousCompleteCount,
      explicitlyComplete: complete === undefined ? true : complete === true,
    }),
    note: "Dry run only. Unapproved structured feeds may be inspected here, but no product, offer, signal, health, approval or registry state is written.",
  };
}
