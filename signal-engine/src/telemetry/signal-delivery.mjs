import crypto from "node:crypto";

export async function recordSignalDeliveryAttempt(store, attempt) {
  if (!store || typeof store.pool !== "function") return { recorded: false, reason: "store_not_persistent" };
  if (!attempt?.signalId) throw new Error("signalId is required for signal delivery telemetry");

  const pool = await store.pool();
  const attemptedAt = Number.isFinite(attempt.attemptedAt) ? Math.floor(attempt.attemptedAt) : Math.floor(Date.now() / 1000);
  const id = `sda_${crypto.randomUUID().replaceAll("-", "")}`;
  const channel = attempt.channel || "discord";
  const result = attempt.result || "failed";
  const providerMessageId = attempt.providerMessageId || null;
  const detail = attempt.detail == null ? null : String(attempt.detail).slice(0, 1000);

  await pool.query(
    `INSERT INTO fatedrop_signal_delivery_attempts (id,signal_id,channel,attempted_at,result,provider_message_id,detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, attempt.signalId, channel, attemptedAt, result, providerMessageId, detail],
  );

  return { recorded: true, id };
}
