import { normalizeWhitespace, stableId } from '../../core/normalize.mjs';

const SET_CODE_PATTERN = /\b(OPK|OP|EB|PRB|ST|DP|LD)-?\s?(\d{1,2})\b/gi;
const SEALED_EVIDENCE = /\b(?:booster (?:box|display|pack|case)|starter deck|double pack|gift collection|devil fruit collection|premium card collection|treasure booster set|deck collection|learn together deck set)\b/i;
const NON_SEALED_EVIDENCE = /\b(?:single cards?|singles|graded|psa|cgc|bgs|opened|unsealed|empty box|mystery|break|rip and ship|accessor(?:y|ies)|sleeves?|binder|play\s?mat|deck box)\b/i;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalSetCode(prefix, digits) {
  return `${String(prefix).toUpperCase()}-${String(digits).padStart(2, '0')}`;
}

export function onePieceSetCodes(title = '') {
  const codes = [];
  for (const match of String(title).matchAll(SET_CODE_PATTERN)) {
    codes.push(canonicalSetCode(match[1], match[2]));
  }
  return Object.freeze(unique(codes));
}

export function onePieceProductType(title = '') {
  const value = normalizeWhitespace(title).toLowerCase();
  if (/\bbooster case\b|\bcase of \d+ (?:booster )?boxes\b/.test(value)) return 'booster_case';
  if (/\bbooster (?:box|display)\b/.test(value)) return 'booster_box';
  if (/\bbooster pack\b/.test(value)) return 'booster_pack';
  if (/\bstarter deck\b|\blearn together deck set\b/.test(value)) return 'starter_deck';
  if (/\bdouble pack\b/.test(value)) return 'double_pack';
  if (/\bdevil fruit collection\b/.test(value)) return 'devil_fruit_collection';
  if (/\bgift collection\b/.test(value)) return 'gift_collection';
  if (/\bpremium card collection\b/.test(value)) return 'premium_card_collection';
  if (/\btreasure booster set\b/.test(value)) return 'treasure_booster_set';
  if (/\bdeck collection\b/.test(value)) return 'deck_collection';
  return 'unknown';
}

function explicitLanguageEvidence(title = '') {
  const value = normalizeWhitespace(title).toLowerCase();
  const languages = [];
  if (/\benglish(?: edition| release| version)?\b/.test(value)) languages.push('en');
  if (/\bjapanese(?: edition| release| version)?\b/.test(value)) languages.push('ja');
  if (/\bkorean(?: edition| release| version)?\b|\bopk-?\d+\b/.test(value)) languages.push('ko');
  if (/\bsimplified chinese\b/.test(value)) languages.push('zh-Hans');
  if (/\btraditional chinese\b/.test(value)) languages.push('zh-Hant');
  return unique(languages);
}

function explicitMarketEvidence(title = '') {
  const value = normalizeWhitespace(title).toLowerCase();
  const markets = [];
  if (/\b(?:uk|united kingdom|great britain|gb) release\b/.test(value)) markets.push('GB');
  if (/\b(?:eu|european) release\b/.test(value)) markets.push('EU');
  if (/\bjapanese release\b/.test(value)) markets.push('JP');
  if (/\bkorean release\b/.test(value)) markets.push('KR');
  if (/\b(?:north american|na) release\b/.test(value)) markets.push('NA');
  return unique(markets);
}

function explicitPrintingEvidence(title = '') {
  const value = normalizeWhitespace(title).toLowerCase();
  const printings = [];
  if (/\bfirst edition\b/.test(value)) printings.push('first_edition');
  if (/\breprint\b/.test(value)) printings.push('reprint');
  if (/\bunlimited(?: edition)?\b/.test(value)) printings.push('unlimited');
  return unique(printings);
}

function explicitVariantEvidence(title = '') {
  const value = normalizeWhitespace(title).toLowerCase();
  const variants = [];
  if (/\bmanga(?: rare| art)?\b/.test(value)) variants.push('manga');
  if (/\bparallel(?: rare| art)?\b/.test(value)) variants.push('parallel');
  if (/\b(?:alternate|alt) art\b/.test(value)) variants.push('alternate_art');
  if (/\bseriali[sz]ed\b/.test(value)) variants.push('serialized');
  return unique(variants);
}

export function classifyOnePieceSealedOffer(product = {}, { retailerId = product.retailerId } = {}) {
  const title = normalizeWhitespace(product.title);
  const setCodes = onePieceSetCodes(title);
  const productType = onePieceProductType(title);
  const languages = explicitLanguageEvidence(title);
  const markets = explicitMarketEvidence(title);
  const printings = explicitPrintingEvidence(title);
  const variants = explicitVariantEvidence(title);
  const reasons = [];

  if (!/\bone piece\b/i.test(title) && setCodes.length === 0) reasons.push('one_piece_identity_missing');
  if (!SEALED_EVIDENCE.test(title) || productType === 'unknown') reasons.push('sealed_product_type_unresolved');
  if (NON_SEALED_EVIDENCE.test(title)) reasons.push('non_sealed_or_unsafe_product');
  if (setCodes.length === 0) reasons.push('set_code_unresolved');
  if (setCodes.length > 1) reasons.push('conflicting_set_codes');
  if (languages.length === 0) reasons.push('language_unresolved');
  if (languages.length > 1) reasons.push('conflicting_language_evidence');
  if (markets.length > 1) reasons.push('conflicting_market_evidence');
  if (printings.length > 1) reasons.push('conflicting_printing_evidence');
  if (variants.length > 1) reasons.push('conflicting_variant_evidence');

  const conflicting = reasons.some((reason) => reason.startsWith('conflicting_'));
  const rejected = reasons.includes('non_sealed_or_unsafe_product')
    || reasons.includes('one_piece_identity_missing')
    || reasons.includes('sealed_product_type_unresolved');
  const matched = !conflicting && !rejected && setCodes.length === 1;
  const identity = Object.freeze({
    tcgCode: 'one-piece',
    setCode: setCodes.length === 1 ? setCodes[0] : null,
    productType: productType === 'unknown' ? null : productType,
    marketCode: markets.length === 1 ? markets[0] : null,
    languageCode: languages.length === 1 ? languages[0] : null,
    printingCode: printings.length === 1 ? printings[0] : null,
    variantCode: variants.length === 1 ? variants[0] : null,
  });
  const identityKey = matched
    ? [identity.tcgCode, identity.setCode, identity.productType, identity.marketCode || 'unknown-market', identity.languageCode || 'unknown-language', identity.printingCode || 'unknown-printing', identity.variantCode || 'unknown-variant'].join('|')
    : null;

  return Object.freeze({
    status: conflicting ? 'conflicting' : matched ? 'matched' : rejected ? 'rejected' : 'unresolved',
    identity,
    identityKey,
    identityId: identityKey ? stableId('fdopproduct', identityKey) : null,
    reasons: Object.freeze(reasons),
    evidence: Object.freeze({
      retailerId: retailerId || null,
      retailerSku: product.retailerSku || null,
      title,
      sourceUrl: product.url || null,
      explicitSetCodes: setCodes,
      explicitLanguages: Object.freeze(languages),
      explicitMarkets: Object.freeze(markets),
      explicitPrintings: Object.freeze(printings),
      explicitVariants: Object.freeze(variants),
    }),
  });
}

export const ONE_PIECE_SHADOW_FILTERS = Object.freeze({
  include: /one piece|\b(?:OPK|OP|EB|PRB|ST|DP|LD)-?\s?\d{1,2}\b/i,
  exclude: NON_SEALED_EVIDENCE,
});
