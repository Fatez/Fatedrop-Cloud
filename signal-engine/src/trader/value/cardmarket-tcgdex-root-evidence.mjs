import fs from 'node:fs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';

const SP_MARKERS = new Set(['G', 'GL', 'FB', 'C', 'E4', 'M']);

export const ROOT_FINISH_POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

function findBalancedEnd(source, start, openChar, closeChar) {
  if (source[start] !== openChar) return -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function balancedAfter(source, regex, openChar, closeChar) {
  const match = regex.exec(source);
  if (!match) return null;
  const start = source.indexOf(openChar, match.index + match[0].length - 1);
  if (start < 0) return null;
  const end = findBalancedEnd(source, start, openChar, closeChar);
  return end < 0 ? null : source.slice(start, end + 1);
}

function integerProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(\\d+)`).exec(source);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function getRootCardmarketProductId(card) {
  try {
    const source = fs.readFileSync(card.sourcePath, 'utf8');
    const root = balancedAfter(source, /:\s*Card\s*=\s*\{/, '{', '}');
    if (!root) return null;
    const match = /\n\tthirdParty\s*:\s*\{/.exec(root);
    if (!match) return null;
    const start = root.indexOf('{', match.index + match[0].length - 1);
    const end = findBalancedEnd(root, start, '{', '}');
    if (end < 0) return null;
    return integerProperty(root.slice(start, end + 1), 'cardmarket');
  } catch {
    return null;
  }
}

function comparableCardName(value) {
  let normalized = String(value || '').trim()
    .replace(/♀/g, ' female ')
    .replace(/♂/g, ' male ')
    .replace(/[☆★]/g, ' gold star ')
    .replace(/\bGold Star\b/gi, ' gold star ')
    .replace(/-EX\b/gi, ' EX');
  normalized = normalized.replace(/^M\s+(?=\S+\s+EX\b)/i, 'M');
  return normaliseComparableName(normalized);
}

function comparableProviderName(value) {
  let normalized = String(value || '').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const trailingDescriptor = /\s+\[[^[\]]+\]\s*$/;
  while (trailingDescriptor.test(normalized)) normalized = normalized.replace(trailingDescriptor, '').trim();
  normalized = normalized
    .replace(/\s+Lv\.\s*\d+\b/gi, ' ')
    .replace(/δ\s+Delta Species\b/gi, 'δ')
    .replace(/\[([A-Za-z0-9]+)\]/g, (all, marker) => SP_MARKERS.has(String(marker).toUpperCase()) ? ` ${String(marker).toUpperCase()} ` : all)
    .replace(/\s+/g, ' ')
    .trim();
  return comparableCardName(normalized);
}

export function rootProductNameMatches(identityName, productName) {
  const canonical = comparableCardName(identityName);
  return Boolean(canonical) && canonical === comparableProviderName(productName);
}

function isBaselineVariant(variant, tcgdexType) {
  return variant?.type === tcgdexType
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

export function assessBaselineFinishEvidence(card, variantCode, rootProductId) {
  const policy = ROOT_FINISH_POLICY[variantCode];
  if (!policy) return Object.freeze({ ok: false, reason: 'unsupported_target_finish' });
  const baseline = (card?.variants || []).filter((variant) => isBaselineVariant(variant, policy.tcgdexType));
  if (baseline.length === 0) {
    return Object.freeze({ ok: false, reason: 'no_baseline_target_variant', policy, baselineCount: 0, explicitProductIds: [] });
  }
  const explicitProductIds = [...new Set(
    baseline
      .map((variant) => Number(variant.cardmarketProductId))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )];
  if (explicitProductIds.length > 1) {
    return Object.freeze({ ok: false, reason: 'multiple_baseline_target_product_ids', policy, baselineCount: baseline.length, explicitProductIds });
  }
  if (explicitProductIds.length === 1 && explicitProductIds[0] !== Number(rootProductId)) {
    return Object.freeze({ ok: false, reason: 'baseline_target_product_disagrees_with_root', policy, baselineCount: baseline.length, explicitProductIds });
  }
  return Object.freeze({ ok: true, reason: 'baseline_target_finish_proven', policy, baselineCount: baseline.length, explicitProductIds });
}
