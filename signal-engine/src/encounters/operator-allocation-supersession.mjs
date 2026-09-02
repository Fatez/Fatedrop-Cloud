const OPERATOR_SOURCE_PREFIX = "github:Fatez/Fatedrop-Cloud:issue:";

export function normalizeOperatorIssueSupersessionList(value, currentIssueNumber, maxItems = 50) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("supersedesOperatorIssues must be an array of prior operator issue numbers");
  if (value.length > maxItems) throw new Error(`supersedesOperatorIssues may contain at most ${maxItems} issue numbers`);

  const current = Number(currentIssueNumber);
  if (!Number.isInteger(current) || current <= 0) throw new Error("Current operator issue number is invalid");

  const unique = new Set();
  for (const item of value) {
    const issueNumber = Number(item);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("supersedesOperatorIssues must contain positive integer issue numbers");
    }
    if (issueNumber >= current) {
      throw new Error("supersedesOperatorIssues may only reference earlier operator issues");
    }
    unique.add(issueNumber);
  }
  return [...unique];
}

export async function supersedeOperatorPhysicalEchoObservations({
  store,
  retailerId,
  operatorIssueNumbers = [],
  supersededByOperatorIssue,
  now = Date.now(),
} = {}) {
  const issues = [...new Set((Array.isArray(operatorIssueNumbers) ? operatorIssueNumbers : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (!issues.length) return { superseded: 0, operatorIssueNumbers: [] };
  if (!store) throw new Error("Operator allocation supersession requires the canonical store");

  const replacementIssue = Number(supersededByOperatorIssue);
  if (!Number.isInteger(replacementIssue) || replacementIssue <= 0) {
    throw new Error("Operator allocation supersession requires a valid replacement issue number");
  }
  if (issues.some((issueNumber) => issueNumber >= replacementIssue)) {
    throw new Error("Operator allocation supersession may only retire earlier operator issues");
  }

  const supersededAt = new Date(Number(now)).toISOString();
  if (typeof store.supersedeOperatorPhysicalEchoObservations === "function") {
    const result = await store.supersedeOperatorPhysicalEchoObservations({
      retailerId,
      operatorIssueNumbers: issues,
      supersededByOperatorIssue: replacementIssue,
      supersededAt,
    });
    return {
      superseded: Number(result?.superseded ?? result?.rowCount ?? 0),
      operatorIssueNumbers: issues,
      supersededAt,
    };
  }

  if (typeof store.pool !== "function") throw new Error("Operator allocation supersession persistence is unavailable");
  const pool = await store.pool();
  const result = await pool.query(`
    UPDATE fatedrop_signal_events
    SET evidence_json = COALESCE(evidence_json, '{}'::jsonb) || jsonb_build_object(
      'expiresAt', $1::text,
      'supersededAt', $1::text,
      'supersededByOperatorIssue', $2::int,
      'supersessionReason', 'operator_batch_replaced'
    )
    WHERE retailer_id = $3
      AND kind = 'echo'
      AND location_id IS NOT NULL
      AND COALESCE(evidence_json->>'availabilityScope', '') = 'physical_branch'
      AND COALESCE(evidence_json->>'alertChannel', '') = 'echo'
      AND EXISTS (
        SELECT 1
        FROM unnest($4::int[]) AS prior(issue_number)
        WHERE COALESCE(evidence_json->>'sourceId', '') LIKE
          $5::text || prior.issue_number::text || ':%'
      )
  `, [supersededAt, replacementIssue, retailerId, issues, OPERATOR_SOURCE_PREFIX]);

  return {
    superseded: Number(result?.rowCount || 0),
    operatorIssueNumbers: issues,
    supersededAt,
  };
}
