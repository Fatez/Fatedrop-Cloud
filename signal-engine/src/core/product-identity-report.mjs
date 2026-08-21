import { compareProductIdentity, describeProductIdentity } from "./product-identity.mjs";

function candidateBucket(record) {
  const descriptor = describeProductIdentity(record);
  if (!descriptor.coreSignature || !descriptor.productType) return null;
  return `${descriptor.productType}\u241f${descriptor.coreSignature}`;
}

function pairKey(left, right) {
  return [String(left.retailerId || ""), String(left.title || ""), String(right.retailerId || ""), String(right.title || "")].join("\u241f");
}

export function buildIdentityDryRunReport(records = []) {
  const normalized = records
    .filter((record) => record && record.title)
    .map((record) => ({ ...record, descriptor: describeProductIdentity(record) }));

  const buckets = new Map();
  for (const record of normalized) {
    const key = candidateBucket(record);
    if (!key) continue;
    const rows = buckets.get(key) || [];
    rows.push(record);
    buckets.set(key, rows);
  }

  const pairs = [];
  const seen = new Set();
  for (const [bucket, rows] of buckets) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const left = rows[i];
        const right = rows[j];
        if (left.retailerId && right.retailerId && left.retailerId === right.retailerId) continue;
        const key = pairKey(left, right);
        if (seen.has(key)) continue;
        seen.add(key);
        const comparison = compareProductIdentity(left, right);
        pairs.push({
          bucket,
          decision: comparison.decision,
          confidence: comparison.confidence,
          reasons: comparison.reasons,
          left: {
            retailerId: left.retailerId || null,
            title: left.title,
            productType: comparison.left.productType,
          },
          right: {
            retailerId: right.retailerId || null,
            title: right.title,
            productType: comparison.right.productType,
          },
        });
      }
    }
  }

  const byDecision = { match: 0, ambiguous: 0, reject: 0 };
  for (const pair of pairs) byDecision[pair.decision] += 1;

  return {
    recordsSeen: normalized.length,
    candidateBuckets: [...buckets.values()].filter((rows) => new Set(rows.map((row) => row.retailerId || "")).size > 1).length,
    crossRetailerPairs: pairs.length,
    byDecision,
    matches: pairs.filter((pair) => pair.decision === "match"),
    ambiguous: pairs.filter((pair) => pair.decision === "ambiguous"),
    rejected: pairs.filter((pair) => pair.decision === "reject"),
  };
}
