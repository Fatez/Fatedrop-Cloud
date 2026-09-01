function clean(value, max = 240) {
  const text = String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function key(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.map((value) => clean(value, 180)).filter(Boolean))];
}

const PRODUCT_WORDS = /booster|elite trainer|\betb\b|tin\b|collection|blister|bundle|box\b|pack\b|deck\b|ultra premium|poster|battle|celebration/i;
const RELEASE_PREFIX = /^(?:released?|release date|releases?|available|expected|delayed|launch(?:es|ing)?)(?:\s*:|\s+-|\s+–)?/i;
const LIMIT_LINE = /limited\s+to\s+\d+\s+(?:per|\/)?\s*customer/i;
const ALLOCATION_LINE = /only\s+stores?\s+listed\s+will\s+receive\s+limited\s+stock/i;
const BRANCH_LINE = /^The Entertainer\s+.+/i;

function likelyProductTitle(line) {
  if (!line || line.length < 8 || line.length > 240) return false;
  const pokemon = /pok[eé]mon\s+(?:tcg|trading card)|\b30th\s+celebration\b/i.test(line);
  return pokemon && PRODUCT_WORDS.test(line);
}

function releaseLabel(section) {
  for (let index = 0; index < section.length; index += 1) {
    const line = section[index];
    if (!RELEASE_PREFIX.test(line)) continue;
    const stripped = line.replace(RELEASE_PREFIX, "").trim();
    if (stripped) return clean(line, 160);
    const following = section[index + 1];
    if (following && /\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+(?:\s+20\d{2})?\b/.test(following)) {
      return clean(`${line} ${following}`, 160);
    }
    return clean(line, 160);
  }
  return null;
}

function purchaseLimit(section) {
  return clean(section.find((line) => LIMIT_LINE.test(line)), 120);
}

export function parseEntertainerPokemonAllocationText(renderedText = "") {
  const lines = String(renderedText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line, 500))
    .filter(Boolean);

  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (likelyProductTitle(lines[index])) starts.push(index);
  }

  const byTitle = new Map();
  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position];
    const end = starts[position + 1] ?? lines.length;
    const section = lines.slice(start, end);
    const title = clean(lines[start], 240);
    const branches = unique(section.filter((line) => BRANCH_LINE.test(line)));
    if (!title || !branches.length) continue;
    const productKey = key(title);
    const existing = byTitle.get(productKey);
    const product = {
      title,
      releaseLabel: releaseLabel(section),
      purchaseLimit: purchaseLimit(section),
      allocationLimited: section.some((line) => ALLOCATION_LINE.test(line)),
      branches,
    };
    if (!existing) {
      byTitle.set(productKey, product);
      continue;
    }
    byTitle.set(productKey, {
      ...existing,
      releaseLabel: existing.releaseLabel || product.releaseLabel,
      purchaseLimit: existing.purchaseLimit || product.purchaseLimit,
      allocationLimited: existing.allocationLimited || product.allocationLimited,
      branches: unique([...existing.branches, ...product.branches]),
    });
  }

  const products = [...byTitle.values()]
    .map((product) => ({ ...product, branches: [...product.branches].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => key(a.title).localeCompare(key(b.title)));

  return {
    products,
    diagnostics: {
      renderedLines: lines.length,
      productHeadingsSeen: starts.length,
      productsWithNamedAllocations: products.length,
      namedBranchReferences: products.reduce((sum, product) => sum + product.branches.length, 0),
    },
  };
}

export function renderedPageLooksBlocked(renderedText = "") {
  const text = String(renderedText || "").toLowerCase();
  return [
    "verify you are human",
    "access denied",
    "checking your browser",
    "captcha",
    "temporarily blocked",
  ].some((marker) => text.includes(marker));
}
