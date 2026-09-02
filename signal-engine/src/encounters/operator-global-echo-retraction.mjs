const RETRACTION_KIND = "operator_global_echo_retraction";
const TARGET_KIND = "operator_retailer_readiness";
const RETRACTION_PREFIX = "operator-echo-retraction:";

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseEvidence(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function taggedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function operatorEchoRetractionId(eventId) {
  const cleanEventId = cleanText(eventId, 180);
  return cleanEventId ? `${RETRACTION_PREFIX}${cleanEventId}` : null;
}

export function validateRetractableManualGlobalEcho(row) {
  if (!row || row.kind !== TARGET_KIND) throw taggedError("ECHO_NOT_RETRACTABLE", "Only manual operator Echoes may be retracted.");
  const evidence = parseEvidence(row.evidence_json);
  if (Number(evidence.schemaVersion) !== 1
    || evidence.stage !== "echo"
    || evidence.signalKind !== "operator_readiness"
    || evidence.availabilityScope !== "online_retailer_readiness"
    || evidence.availabilityVerified !== false
    || evidence.sourceType !== "operator_manual") {
    throw taggedError("ECHO_NOT_RETRACTABLE", "Only manually created Global Echoes may be retracted.");
  }
  const operatorIssue = Number(evidence.operatorIssue);
  if (!Number.isInteger(operatorIssue) || operatorIssue <= 0) throw taggedError("ECHO_NOT_RETRACTABLE", "Manual Echo provenance is incomplete.");
  return { evidence, operatorIssue };
}

export function parseOperatorEchoRetraction(row, targetEventId = null) {
  if (!row || row.kind !== RETRACTION_KIND) return null;
  const evidence = parseEvidence(row.evidence_json);
  const target = cleanText(evidence.targetEventId, 180);
  const retractedBy = cleanText(evidence.retractedBy, 180);
  const reason = cleanText(evidence.reason, 300);
  const retractedAt = cleanText(evidence.retractedAt, 80);
  if (Number(evidence.schemaVersion) !== 1 || evidence.status !== "retracted" || !target || !retractedBy || !reason || !retractedAt) return null;
  if (targetEventId && target !== targetEventId) return null;
  return {
    status: "retracted",
    targetEventId: target,
    retractedAt,
    retractedBy,
    reason,
    operatorIssue: Number.isInteger(Number(evidence.operatorIssue)) ? Number(evidence.operatorIssue) : null,
  };
}

async function requireOwnerRole(client, userId) {
  const cleanUserId = cleanText(userId, 180);
  if (!cleanUserId) throw taggedError("OWNER_REQUIRED", "Owner authority is required.");
  let rows;
  try {
    ({ rows } = await client.query(
      "SELECT user_id,role FROM fatedrop_admin_roles WHERE user_id=$1 AND role='owner' LIMIT 1",
      [cleanUserId],
    ));
  } catch {
    throw taggedError("OWNER_REQUIRED", "Owner authority could not be verified.");
  }
  if (!rows[0] || String(rows[0].role) !== "owner") throw taggedError("OWNER_REQUIRED", "Owner authority is required.");
  return cleanUserId;
}

export async function readManualGlobalEchoRetraction({ store, eventId }) {
  if (!store || typeof store.pool !== "function") throw taggedError("STORE_REQUIRED", "Canonical store is required.");
  const targetEventId = cleanText(eventId, 180);
  const retractionId = operatorEchoRetractionId(targetEventId);
  if (!targetEventId || !retractionId) throw taggedError("EVENT_REQUIRED", "Echo event id is required.");
  const pool = await store.pool();
  const { rows } = await pool.query(
    "SELECT id,kind,occurred_at,evidence_json FROM fatedrop_signal_events WHERE id=$1 AND kind=$2 LIMIT 1",
    [retractionId, RETRACTION_KIND],
  );
  return parseOperatorEchoRetraction(rows[0], targetEventId);
}

export async function retractManualGlobalEcho({ store, eventId, reason, retractedBy, now = Date.now() }) {
  if (!store || typeof store.pool !== "function") throw taggedError("STORE_REQUIRED", "Canonical store is required.");
  const targetEventId = cleanText(eventId, 180);
  const cleanReason = cleanText(reason, 300);
  if (!targetEventId) throw taggedError("EVENT_REQUIRED", "Echo event id is required.");
  if (cleanReason.length < 3) throw taggedError("REASON_REQUIRED", "A short retraction reason is required.");
  const retractionId = operatorEchoRetractionId(targetEventId);
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const operatorUserId = await requireOwnerRole(client, retractedBy);
    const originalResult = await client.query(
      "SELECT id,kind,occurred_at,evidence_json FROM fatedrop_signal_events WHERE id=$1 LIMIT 1 FOR SHARE",
      [targetEventId],
    );
    const original = originalResult.rows[0];
    if (!original) throw taggedError("ECHO_NOT_FOUND", "Manual Echo was not found.");
    const { evidence: originalEvidence, operatorIssue } = validateRetractableManualGlobalEcho(original);

    const existingResult = await client.query(
      "SELECT id,kind,occurred_at,evidence_json FROM fatedrop_signal_events WHERE id=$1 AND kind=$2 LIMIT 1",
      [retractionId, RETRACTION_KIND],
    );
    const existing = parseOperatorEchoRetraction(existingResult.rows[0], targetEventId);
    if (existing) {
      await client.query("COMMIT");
      return { retracted: true, duplicate: true, eventId: targetEventId, retractionId, retraction: existing };
    }

    const retractedAtEpoch = Math.max(1, Math.floor(Number(now) / 1000));
    const retractedAt = new Date(retractedAtEpoch * 1000).toISOString();
    const originalCreatedAt = Number(original.occurred_at) > 0 ? new Date(Number(original.occurred_at) * 1000).toISOString() : null;
    const evidence = {
      schemaVersion: 1,
      status: "retracted",
      targetEventId,
      retractedAt,
      retractedBy: operatorUserId,
      reason: cleanReason,
      operatorIssue,
      originalKind: TARGET_KIND,
      originalCreatedAt,
      originalSourceType: originalEvidence.sourceType,
      originalAvailabilityScope: originalEvidence.availabilityScope,
      lifecycleEffect: "none",
      canonicalStockTruthChanged: false,
    };
    await client.query(
      `INSERT INTO fatedrop_signal_events
        (id,kind,product_identity_id,offer_id,retailer_id,location_id,occurred_at,evidence_json)
       VALUES ($1,$2,NULL,NULL,NULL,NULL,$3,$4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [retractionId, RETRACTION_KIND, retractedAtEpoch, JSON.stringify(evidence)],
    );
    const insertedResult = await client.query(
      "SELECT id,kind,occurred_at,evidence_json FROM fatedrop_signal_events WHERE id=$1 AND kind=$2 LIMIT 1",
      [retractionId, RETRACTION_KIND],
    );
    const retraction = parseOperatorEchoRetraction(insertedResult.rows[0], targetEventId);
    if (!retraction) throw taggedError("RETRACTION_WRITE_FAILED", "Retraction audit event was not persisted.");
    await client.query("COMMIT");
    return { retracted: true, duplicate: false, eventId: targetEventId, retractionId, retraction };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export const OPERATOR_GLOBAL_ECHO_RETRACTION_KIND = RETRACTION_KIND;
