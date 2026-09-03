export const POKEMON_WIZARD_SOURCE_NAME = 'pokemon-wizard';
export const POKEMON_WIZARD_ACQUISITION_MODE = 'manual-reference';
export const POKEMON_WIZARD_ALLOWED_HOSTS = Object.freeze([
  'pokemonwizard.com',
  'www.pokemonwizard.com',
]);

export const POKEMON_WIZARD_REFERENCE_POLICY = Object.freeze({
  automatedAcquisitionAuthorized: false,
  persistenceAuthorized: false,
  redistributionAuthorized: false,
  bulkExtractionAuthorized: false,
  purpose: 'internal-reference-validation',
});

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function requireTimestamp(value, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive timestamp`);
  }
  return Math.trunc(value);
}

function requireNonNegativePrice(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return number;
}

function requirePositiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive finite number`);
  }
  return number;
}

function normaliseCurrency(value) {
  const code = requireText(value, 'currencyCode').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new TypeError('currencyCode must be an ISO-style 3-letter code');
  }
  return code;
}

function requirePokemonWizardUrl(value) {
  const text = requireText(value, 'sourceUrl');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('sourceUrl must be a valid URL');
  }

  if (url.protocol !== 'https:' || !POKEMON_WIZARD_ALLOWED_HOSTS.includes(url.hostname)) {
    throw new TypeError('sourceUrl must be an HTTPS Pokemon Wizard URL');
  }

  return url.toString();
}

function requireVerifiedCardIdentity(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('cardIdentity is required');
  }
  const id = requireText(input.id, 'cardIdentity.id');
  if (input.verificationStatus !== 'verified') {
    throw new TypeError('Pokemon Wizard reference requires a verified canonical card identity');
  }
  return Object.freeze({
    id,
    verificationStatus: 'verified',
  });
}

function buildComparison(referencePrice, referenceCurrency, benchmarkPrice, benchmarkCurrency, extra = {}) {
  const delta = referencePrice - benchmarkPrice;
  const deltaPercent = benchmarkPrice === 0
    ? null
    : (delta / benchmarkPrice) * 100;

  return Object.freeze({
    comparable: true,
    referenceCurrency,
    benchmarkCurrency,
    referencePrice,
    benchmarkPrice,
    delta,
    deltaPercent,
    ...extra,
  });
}

export function buildPokemonWizardManualReference(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Pokemon Wizard reference input is required');
  }

  const cardIdentity = requireVerifiedCardIdentity(input.cardIdentity);

  return Object.freeze({
    sourceName: POKEMON_WIZARD_SOURCE_NAME,
    acquisitionMode: POKEMON_WIZARD_ACQUISITION_MODE,
    purpose: POKEMON_WIZARD_REFERENCE_POLICY.purpose,
    sourceUrl: requirePokemonWizardUrl(input.sourceUrl),
    sourceObservedAt: requireTimestamp(input.sourceObservedAt ?? Date.now(), 'sourceObservedAt'),
    cardIdentityId: cardIdentity.id,
    quotedPrice: requireNonNegativePrice(input.quotedPrice, 'quotedPrice'),
    currencyCode: normaliseCurrency(input.currencyCode ?? 'USD'),
    notes: optionalText(input.notes),
    automatedAcquisitionAuthorized: false,
    persistenceAuthorized: false,
    redistributionAuthorized: false,
    bulkExtractionAuthorized: false,
  });
}

export function comparePokemonWizardReference(reference, benchmark) {
  if (!reference || reference.sourceName !== POKEMON_WIZARD_SOURCE_NAME) {
    throw new TypeError('Pokemon Wizard manual reference is required');
  }
  if (!benchmark || typeof benchmark !== 'object') {
    throw new TypeError('benchmark is required');
  }

  const benchmarkPrice = requireNonNegativePrice(benchmark.price, 'benchmark.price');
  const benchmarkCurrency = normaliseCurrency(benchmark.currencyCode);

  if (benchmarkCurrency !== reference.currencyCode) {
    return Object.freeze({
      comparable: false,
      reason: 'currency_mismatch_fx_required',
      referenceCurrency: reference.currencyCode,
      benchmarkCurrency,
    });
  }

  return buildComparison(
    reference.quotedPrice,
    reference.currencyCode,
    benchmarkPrice,
    benchmarkCurrency,
  );
}

export function comparePokemonWizardReferenceWithFx(reference, benchmark, fxEvidence) {
  if (!reference || reference.sourceName !== POKEMON_WIZARD_SOURCE_NAME) {
    throw new TypeError('Pokemon Wizard manual reference is required');
  }
  if (!benchmark || typeof benchmark !== 'object') {
    throw new TypeError('benchmark is required');
  }
  if (!fxEvidence || typeof fxEvidence !== 'object') {
    throw new TypeError('fxEvidence is required for cross-currency comparison');
  }

  const benchmarkPrice = requireNonNegativePrice(benchmark.price, 'benchmark.price');
  const benchmarkCurrency = normaliseCurrency(benchmark.currencyCode);
  const fxFromCurrency = normaliseCurrency(fxEvidence.fromCurrency);
  const fxToCurrency = normaliseCurrency(fxEvidence.toCurrency);
  const fxRate = requirePositiveNumber(fxEvidence.rate, 'fxEvidence.rate');
  const fxSource = requireText(fxEvidence.source, 'fxEvidence.source');
  const fxObservedAt = requireTimestamp(fxEvidence.observedAt, 'fxEvidence.observedAt');

  if (benchmarkCurrency === reference.currencyCode) {
    throw new TypeError('FX evidence is unnecessary for same-currency comparison');
  }
  if (fxFromCurrency !== reference.currencyCode || fxToCurrency !== benchmarkCurrency) {
    throw new TypeError('FX evidence direction must match reference and benchmark currencies');
  }

  const convertedReferencePrice = reference.quotedPrice * fxRate;

  return buildComparison(
    convertedReferencePrice,
    benchmarkCurrency,
    benchmarkPrice,
    benchmarkCurrency,
    {
      originalReferencePrice: reference.quotedPrice,
      originalReferenceCurrency: reference.currencyCode,
      fxRate,
      fxSource,
      fxObservedAt,
      fxApplied: true,
      purpose: 'internal-reference-validation',
      persistenceAuthorized: false,
      redistributionAuthorized: false,
    },
  );
}
