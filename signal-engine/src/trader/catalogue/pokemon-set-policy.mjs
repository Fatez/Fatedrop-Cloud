import { normaliseComparableName } from './reconcile.mjs';

const REVIEWED_SET_ALIASES = Object.freeze([
  Object.freeze({ tcgdexSetId: 'base1', pokemonTcgSetId: 'base1', tcgdexName: 'Base Set', pokemonTcgName: 'Base', reason: 'reviewed_source_naming_alias' }),
  Object.freeze({ tcgdexSetId: 'hgss1', pokemonTcgSetId: 'hgss1', tcgdexName: 'HeartGold SoulSilver', pokemonTcgName: 'HeartGold & SoulSilver', reason: 'reviewed_source_naming_alias' }),
  Object.freeze({ tcgdexSetId: 'hgss2', pokemonTcgSetId: 'hgss2', tcgdexName: 'Unleashed', pokemonTcgName: 'HS—Unleashed', reason: 'reviewed_source_prefix_alias' }),
  Object.freeze({ tcgdexSetId: 'hgss3', pokemonTcgSetId: 'hgss3', tcgdexName: 'Undaunted', pokemonTcgName: 'HS—Undaunted', reason: 'reviewed_source_prefix_alias' }),
  Object.freeze({ tcgdexSetId: 'hgss4', pokemonTcgSetId: 'hgss4', tcgdexName: 'Triumphant', pokemonTcgName: 'HS—Triumphant', reason: 'reviewed_source_prefix_alias' }),
  Object.freeze({ tcgdexSetId: 'svp', pokemonTcgSetId: 'svp', tcgdexName: 'SVP Black Star Promos', pokemonTcgName: 'Scarlet & Violet Black Star Promos', reason: 'reviewed_source_abbreviation_alias' }),
  Object.freeze({ tcgdexSetId: 'sve', pokemonTcgSetId: 'sve', tcgdexName: 'Scarlet & Violet Energy', pokemonTcgName: 'Scarlet & Violet Energies', reason: 'reviewed_source_pluralisation_alias' }),
  Object.freeze({ tcgdexSetId: 'fut2020', pokemonTcgSetId: 'fut20', tcgdexName: 'Pokémon Futsal 2020', pokemonTcgName: 'Pokémon Futsal Collection', reason: 'reviewed_source_naming_alias' }),
]);

const REVIEWED_ALIAS_BY_TCGDEX_ID = new Map(REVIEWED_SET_ALIASES.map((entry) => [entry.tcgdexSetId, entry]));

const EXPLICIT_EXCLUSIONS = Object.freeze(new Map([
  ['jumbo', Object.freeze({ category: 'jumbo', reason: 'non_standard_jumbo_card_group' })],
  ['sp', Object.freeze({ category: 'sample', reason: 'sample_card_group' })],
  ['mfb', Object.freeze({ category: 'intro_product', reason: 'introductory_product_not_standard_expansion' })],
  ['ex5.5', Object.freeze({ category: 'creator_pack', reason: 'special_creator_pack_not_standard_expansion' })],
  ['exu', Object.freeze({ category: 'subset', reason: 'source_specific_subset_not_independent_expansion' })],
  ['xya', Object.freeze({ category: 'alternate', reason: 'alternate_print_group_not_independent_expansion' })],
  ['wp', Object.freeze({ category: 'promo', reason: 'promotional_print_group_not_standard_expansion' })],
  ['miscp', Object.freeze({ category: 'promo', reason: 'miscellaneous_promotional_group' })],
  ['fut2020', Object.freeze({ category: 'promo', reason: 'event_promotional_collection' })],
  ['mee', Object.freeze({ category: 'energy', reason: 'energy_only_group_not_standard_expansion' })],
  ['sve', Object.freeze({ category: 'energy', reason: 'energy_only_group_not_standard_expansion' })],
]));

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function classification(category, eligibleForGlobalPulse, reason) {
  return Object.freeze({ category, eligibleForGlobalPulse, reason });
}

export function getReviewedPokemonSetAlias(tcgdexSetId, tcgdexSetName = null) {
  const id = text(tcgdexSetId);
  const alias = REVIEWED_ALIAS_BY_TCGDEX_ID.get(id) || null;
  if (!alias) return null;
  if (tcgdexSetName != null && normaliseComparableName(tcgdexSetName) !== normaliseComparableName(alias.tcgdexName)) {
    return null;
  }
  return alias;
}

export function classifyPokemonSetForPulse(set, { asOf = Date.now() } = {}) {
  const tcgdexSetId = text(set?.tcgdexSetId ?? set?.sourceSetId ?? set?.sourceRecordId);
  const setName = text(set?.setName ?? set?.name);
  const seriesName = text(set?.seriesName ?? set?.series);
  const releasedAt = set?.releasedAt == null ? null : Number(set.releasedAt);

  const explicit = EXPLICIT_EXCLUSIONS.get(tcgdexSetId);
  if (explicit) return classification(explicit.category, false, explicit.reason);

  if (/^tk-/i.test(tcgdexSetId) || /trainer\s*kit/i.test(setName)) {
    return classification('trainer_kit', false, 'trainer_kit_not_standard_expansion');
  }
  if (/mcdonald'?s\s+collection/i.test(setName)) {
    return classification('food_promo', false, 'food_promotion_not_standard_expansion');
  }
  if (/black\s+star\s+promos?/i.test(setName)) {
    return classification('promo', false, 'black_star_promo_group_not_standard_expansion');
  }
  if (/^pop$/i.test(seriesName) || /^pop\s+series\s+\d+/i.test(setName)) {
    return classification('promo', false, 'pop_promo_series_not_standard_expansion');
  }
  if (/trainer\s+gallery|galarian\s+gallery|shiny\s+vault|classic\s+collection/i.test(setName)) {
    return classification('subset', false, 'subset_would_double_weight_parent_release');
  }
  if (/\bener(?:gy|gies)\b/i.test(setName)) {
    return classification('energy', false, 'energy_only_group_not_standard_expansion');
  }
  if (/promotional|\bpromos?\b/i.test(setName)) {
    return classification('promo', false, 'promotional_group_not_standard_expansion');
  }

  if (Number.isFinite(releasedAt) && releasedAt > Number(asOf)) {
    return classification('unreleased', false, 'release_date_is_in_the_future');
  }

  return classification('expansion', true, 'released_physical_english_expansion');
}

export function summarisePokemonPulseSetUniverse(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const classified = rows.map((row) => Object.freeze({
    ...row,
    pulseEligibility: classifyPokemonSetForPulse(row, options),
  }));
  const counts = {};
  let eligible = 0;
  for (const row of classified) {
    const category = row.pulseEligibility.category;
    counts[category] = (counts[category] || 0) + 1;
    if (row.pulseEligibility.eligibleForGlobalPulse) eligible += 1;
  }
  return Object.freeze({
    total: classified.length,
    eligible,
    excluded: classified.length - eligible,
    categories: Object.freeze(counts),
    sets: Object.freeze(classified),
  });
}

export { REVIEWED_SET_ALIASES };
