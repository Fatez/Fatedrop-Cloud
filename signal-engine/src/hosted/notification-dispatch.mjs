import crypto from "node:crypto";
import { env } from "../config/env.mjs";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const DISCORD_API = "https://discord.com/api/v10";
const id = (prefix, value) => `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

function retryAt(now, attempts) { return now + Math.min(3600, 30 * (2 ** Math.min(6, attempts))); }

async function deliverPush(pool, row, fetchImpl) {
  const { rows: endpoints } = await pool.query("SELECT * FROM fatedrop_push_endpoints WHERE user_id=$1 AND enabled=true ORDER BY updated_at DESC", [row.user_id]);
  if (!endpoints.length) return { sent: false, terminal: true, detail: "no-enabled-push-endpoint" };
  let sent = 0;
  for (const endpoint of endpoints) {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (env.hostedFateFind.expoAccessToken) headers.authorization = `Bearer ${env.hostedFateFind.expoAccessToken}`;
    const response = await fetchImpl(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify({ to: endpoint.expo_push_token, title: row.title, body: row.body, sound: "default", data: { ...row.payload_json, productUrl: row.url, eventType: row.event_type } }) });
    const payload = await response.json().catch(() => ({}));
    const ticket = payload?.data;
    if (response.ok && ticket?.status !== "error") {
      sent += 1;
      await pool.query("UPDATE fatedrop_push_endpoints SET last_success_at=$2,failure_reason=NULL WHERE id=$1", [endpoint.id, Math.floor(Date.now()/1000)]);
    } else {
      const reason = ticket?.message || payload?.errors?.[0]?.message || `expo-http-${response.status}`;
      await pool.query("UPDATE fatedrop_push_endpoints SET last_failure_at=$2,failure_reason=$3,enabled=CASE WHEN $3 LIKE '%DeviceNotRegistered%' THEN false ELSE enabled END WHERE id=$1", [endpoint.id, Math.floor(Date.now()/1000), String(reason).slice(0,500)]);
    }
  }
  return sent ? { sent: true, detail: `${sent}-push-endpoint(s)` } : { sent: false, terminal: false, detail: "push-provider-failed" };
}

async function deliverDiscord(pool, row, fetchImpl) {
  if (!env.discord.enabled || !env.discord.botToken) return { sent: false, terminal: false, detail: "discord-not-configured" };
  const { rows } = await pool.query("SELECT discord_user_id FROM fatedrop_discord_links WHERE user_id=$1", [row.user_id]);
  const discordUserId = rows[0]?.discord_user_id;
  if (!discordUserId) return { sent: false, terminal: true, detail: "discord-not-linked" };
  const auth = { Authorization: `Bot ${env.discord.botToken}`, "Content-Type": "application/json" };
  const channelResponse = await fetchImpl(`${DISCORD_API}/users/@me/channels`, { method: "POST", headers: auth, body: JSON.stringify({ recipient_id: discordUserId }) });
  if (!channelResponse.ok) return { sent: false, terminal: false, detail: `discord-dm-channel-${channelResponse.status}` };
  const channel = await channelResponse.json();
  const messageResponse = await fetchImpl(`${DISCORD_API}/channels/${channel.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ content: `**${row.title}**\n${row.body}${row.url ? `\n${row.url}` : ""}`, allowed_mentions: { parse: [] } }) });
  if (!messageResponse.ok) return { sent: false, terminal: false, detail: `discord-message-${messageResponse.status}` };
  const message = await messageResponse.json().catch(() => ({}));
  return { sent: true, detail: message.id || "discord-sent", providerMessageId: message.id || null };
}

async function deliverWeb(row) {
  // The hosted match ledger itself is the durable web inbox source. Marking the
  // web channel delivered means the event is available to website/app history.
  return { sent: true, detail: `ledger:${row.event_id}` };
}

export async function dispatchNotificationOutbox(pool, { limit = env.hostedFateFind.outboxBatchSize, now = Math.floor(Date.now()/1000), fetchImpl = fetch } = {}) {
  const { rows } = await pool.query("SELECT * FROM fatedrop_notification_outbox WHERE state IN ('pending','failed') AND next_attempt_at <= $1 ORDER BY created_at ASC LIMIT $2", [now, limit]);
  const summary = { attempted: 0, sent: 0, failed: 0, suppressed: 0 };
  for (const row of rows) {
    summary.attempted += 1;
    await pool.query("UPDATE fatedrop_notification_outbox SET state='sending',attempts=attempts+1,updated_at=$2 WHERE id=$1", [row.id, now]);
    let result;
    try {
      result = row.channel === "push" ? await deliverPush(pool,row,fetchImpl) : row.channel === "discord" ? await deliverDiscord(pool,row,fetchImpl) : await deliverWeb(row);
    } catch (error) {
      result = { sent: false, terminal: false, detail: String(error?.message || error) };
    }
    const attemptId = id("nda", `${row.id}:${now}:${row.attempts + 1}`);
    await pool.query("INSERT INTO fatedrop_notification_delivery_attempts (id,outbox_id,attempted_at,result,provider_message_id,detail) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [attemptId,row.id,now,result.sent?"sent":result.terminal?"suppressed":"failed",result.providerMessageId||null,String(result.detail||"").slice(0,1000)]);
    if (result.sent) {
      summary.sent += 1;
      await pool.query("UPDATE fatedrop_notification_outbox SET state='sent',sent_at=$2,updated_at=$2,last_error=NULL WHERE id=$1", [row.id,now]);
    } else if (result.terminal) {
      summary.suppressed += 1;
      await pool.query("UPDATE fatedrop_notification_outbox SET state='suppressed',updated_at=$2,last_error=$3 WHERE id=$1", [row.id,now,String(result.detail||"").slice(0,1000)]);
    } else {
      summary.failed += 1;
      await pool.query("UPDATE fatedrop_notification_outbox SET state='failed',next_attempt_at=$2,updated_at=$3,last_error=$4 WHERE id=$1", [row.id,retryAt(now,row.attempts+1),now,String(result.detail||"").slice(0,1000)]);
    }
  }
  return summary;
}
