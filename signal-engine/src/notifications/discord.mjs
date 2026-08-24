import { env } from "../config/env.mjs";
import { ALERT_CLASSES, signalCapabilities } from "../core/signal-policy.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_SIGNAL_STATES = new Set(["whisper", "echo", "manifested", "vanished"]);

const STATE_STYLE = Object.freeze({
  whisper: { publicStage: "Whisper", label: "WHISPER", colour: 0x67e8f9, companion: "Oru" },
  echo: { publicStage: "Echo", label: "ECHO", colour: 0xa855f7, companion: "Fenn" },
  manifested: { publicStage: "Manifested", label: "MANIFESTED", colour: 0x49e6b1, companion: "Koru" },
  vanished: { publicStage: "Vanished", label: "VANISHED", colour: 0xff647c, companion: "Nyxen" },
});

const FAMILY_LABEL = Object.freeze({
  [ALERT_CLASSES.PRIMARY_DROP]: "PRIMARY / RRP",
  [ALERT_CLASSES.MARKET_STOCK]: "MARKET / INDIE",
});

function money(pence) {
  if (!Number.isFinite(pence)) return "UNKNOWN";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function percent(value) {
  if (!Number.isFinite(value)) return "UNKNOWN";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function short(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function evidenceValue(signal, kind) {
  if (!Array.isArray(signal?.evidence)) return null;
  const entry = signal.evidence.find((item) => item && item.kind === kind && typeof item.value === "string" && item.value.trim());
  return entry?.value?.trim() || null;
}

function alertClassFor(signal) {
  if (Object.values(ALERT_CLASSES).includes(signal?.alertClass)) return signal.alertClass;
  const fromEvidence = evidenceValue(signal, "signal_alert_class");
  if (Object.values(ALERT_CLASSES).includes(fromEvidence)) return fromEvidence;
  return signalCapabilities(signal?.retailerId).alertClass;
}

function signalKindFor(signal) {
  return signal?.kind || evidenceValue(signal, "signal_kind") || null;
}

function retailerSkuFor(signal) {
  return signal?.retailerSku || evidenceValue(signal, "retailer_sku") || null;
}

function rrpKindFor(signal) {
  return evidenceValue(signal, "rrp_value_kind") || null;
}

function valueLabel(signal) {
  if (!Number.isFinite(signal?.markupPercent)) return null;
  if (signal.markupPercent < -0.5) return `${percent(signal.markupPercent)} · BELOW RRP`;
  if (Math.abs(signal.markupPercent) <= 0.5) return `${percent(signal.markupPercent)} · AT RRP`;
  return `${percent(signal.markupPercent)} · ABOVE RRP`;
}

function descriptionFor(signal, alertClass) {
  const primary = alertClass === ALERT_CLASSES.PRIMARY_DROP;
  if (primary) {
    if (signal.state === "whisper") return "Early retailer/SKU movement detected at a Primary/RRP retailer. Something may be coming — stock is not confirmed yet.";
    if (signal.state === "echo") return "Readiness activity detected at a Primary/RRP retailer. Queue, traffic or security behaviour changed — get ready, but stock is not confirmed yet.";
    if (signal.state === "manifested") return "Verified purchasable stock detected at a Primary/RRP retailer. This is the live drop — go now.";
    return "This Primary/RRP offer is no longer verified purchasable. Check the product page or alternatives.";
  }

  if (signal.state === "whisper") return "New market listing/SKU movement detected. Useful market intelligence, but no live-stock claim is being made yet.";
  if (signal.state === "echo") return "Market readiness activity detected. This is supporting context only; no live-stock claim is being made.";
  if (signal.state === "manifested") return "Verified market stock is live. Check the price against RRP before buying.";
  return "This market offer is no longer verified purchasable. Compare other available sellers before giving up.";
}

function actionLabelFor(state, alertClass) {
  const primary = alertClass === ALERT_CLASSES.PRIMARY_DROP;
  if (state === "whisper") return primary ? "Inspect early signal" : "Inspect listing";
  if (state === "echo") return "Get ready / inspect";
  if (state === "manifested") return primary ? "Buy now" : "View market listing";
  return primary ? "View product / alternatives" : "Compare alternatives";
}

function dedupeKey(signal) {
  const cause = signalKindFor(signal) || "unspecified";
  return [signal?.retailerId || "unknown", signal?.offerId || signal?.productId || signal?.title || "unknown", signal?.state || "unknown", cause].join("|");
}

async function reportDeliveryAttempt(callback, attempt) {
  if (typeof callback !== "function") return;
  try {
    await callback(attempt);
  } catch (error) {
    console.error("[discord] delivery telemetry failed", {
      signalId: attempt.signalId,
      error: String(error?.message || error),
    });
  }
}

export function publicDiscordStage(signalOrState) {
  const state = typeof signalOrState === "string" ? signalOrState : signalOrState?.state;
  return STATE_STYLE[state]?.publicStage || null;
}

export function companionForSignal(signalOrState) {
  const state = typeof signalOrState === "string" ? signalOrState : signalOrState?.state;
  return STATE_STYLE[state]?.companion || null;
}

export function discordChannelForState(state, {
  channelIds = env.discord.channelIds,
  fallbackChannelId = env.discord.premiumDropsChannelId,
} = {}) {
  void fallbackChannelId;
  if (!DISCORD_SIGNAL_STATES.has(state)) return "";
  return channelIds?.[state] || "";
}

export function discordBotTokenForState(state, {
  botTokens = env.discord.botTokens,
  fallbackBotToken = env.discord.botToken,
} = {}) {
  return botTokens?.[state] || fallbackBotToken || "";
}

export function isDiscordSignal(signal) {
  return Boolean(signal && DISCORD_SIGNAL_STATES.has(signal.state));
}

export function buildDiscordSignalMessage(signal) {
  const style = STATE_STYLE[signal.state] || STATE_STYLE.manifested;
  const alertClass = alertClassFor(signal);
  const familyLabel = FAMILY_LABEL[alertClass] || "FATEDROP";
  const productUrl = safeHttpUrl(signal.url || signal.target?.productUrl);
  const thumbnailUrl = safeHttpUrl(signal.imageUrl);
  const confidence = Number.isFinite(signal.confidence) ? `${Math.round(signal.confidence * 100)}%` : "Unknown";
  const retailerSku = retailerSkuFor(signal);
  const exactCause = signalKindFor(signal);
  const rrpKind = rrpKindFor(signal);
  const rrpReferenceBasis = evidenceValue(signal, "rrp_reference_basis");
  const rrpKnown = Number.isFinite(signal.rrpPence);
  const markupKnown = Number.isFinite(signal.markupPercent);

  const fields = [
    { name: "Retailer", value: short(signal.retailerName || signal.retailerId || "Unknown", 1024), inline: true },
    { name: "Price", value: money(signal.pricePence), inline: true },
    { name: "Stock", value: short(signal.stockStatus || "Unknown", 1024), inline: true },
  ];

  if (retailerSku) fields.push({ name: "Retailer SKU", value: short(retailerSku, 1024), inline: true });
  fields.push({
    name: rrpKnown && (!rrpKind || rrpKind === "official") ? "Official RRP" : "RRP / reference",
    value: rrpKnown ? money(signal.rrpPence) : "UNKNOWN — no verified RRP/reference",
    inline: true,
  });
  fields.push({
    name: alertClass === ALERT_CLASSES.MARKET_STOCK ? "Value vs RRP" : "Vs RRP",
    value: markupKnown ? (valueLabel(signal) || percent(signal.markupPercent)) : "UNKNOWN — no verified RRP/reference",
    inline: true,
  });
  if (rrpKnown && rrpKind && rrpKind !== "official" && rrpReferenceBasis) {
    fields.push({ name: "Reference basis", value: short(rrpReferenceBasis, 1024), inline: false });
  }
  fields.push({ name: "Delivery", value: Number.isFinite(signal.postagePence) ? money(signal.postagePence) : "UNKNOWN", inline: true });
  fields.push({ name: "True Price", value: Number.isFinite(signal.deliveredPricePence) ? money(signal.deliveredPricePence) : "UNKNOWN", inline: true });
  if (exactCause) fields.push({ name: "Signal cause", value: short(exactCause.replaceAll("_", " "), 1024), inline: true });
  fields.push({ name: "Signal confidence", value: confidence, inline: true });

  const embed = {
    title: short(`${style.companion} · ${style.label} · ${familyLabel} · ${signal.title || "FateDrop signal"}`, 256),
    description: short(descriptionFor(signal, alertClass), 4096),
    color: style.colour,
    fields,
    footer: { text: short(`${style.companion} · FateDrop Signal · ${familyLabel} · ${signal.id || "test"}`, 2048) },
    timestamp: new Date((signal.detectedAt || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };

  if (productUrl) embed.url = productUrl;
  if (thumbnailUrl) embed.thumbnail = { url: thumbnailUrl };

  const message = { embeds: [embed], allowed_mentions: { parse: [] } };
  if (productUrl) {
    message.components = [{ type: 1, components: [{ type: 2, style: 5, label: actionLabelFor(signal.state, alertClass), url: productUrl }] }];
  }
  return message;
}

export async function sendDiscordSignal(signal, {
  fetchImpl = fetch,
  enabled = env.discord.enabled,
  botToken = null,
  botTokens = env.discord.botTokens,
  fallbackBotToken = env.discord.botToken,
  channelId = null,
  channelIds = env.discord.channelIds,
  fallbackChannelId = env.discord.premiumDropsChannelId,
} = {}) {
  if (!isDiscordSignal(signal)) return { sent: false, reason: "state_not_enabled" };
  const resolvedBotToken = botToken || discordBotTokenForState(signal.state, { botTokens, fallbackBotToken });
  if (!resolvedBotToken) return { sent: false, reason: "missing_bot_token" };
  const resolvedChannelId = channelId || discordChannelForState(signal.state, { channelIds, fallbackChannelId });
  if (!resolvedChannelId) return { sent: false, reason: "missing_lifecycle_channel_id" };
  if (!enabled) return { sent: false, reason: "disabled" };

  const response = await fetchImpl(`${DISCORD_API}/channels/${resolvedChannelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${resolvedBotToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildDiscordSignalMessage(signal)),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord delivery failed (${response.status})${body ? `: ${short(body, 300)}` : ""}`);
  }

  const payload = await response.json().catch(() => ({}));
  return { sent: true, messageId: payload.id ?? null, channelId: resolvedChannelId, companion: companionForSignal(signal.state) };
}

export async function dispatchDiscordSignals(signals, options = {}) {
  const summary = { sent: 0, skipped: 0, failed: 0, errors: [] };
  const onDeliveryAttempt = options.onDeliveryAttempt;
  const seen = new Set();
  for (const signal of signals || []) {
    if (!isDiscordSignal(signal)) { summary.skipped += 1; continue; }
    const key = dedupeKey(signal);
    if (seen.has(key)) {
      summary.skipped += 1;
      await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt: Math.floor(Date.now() / 1000), result: "skipped", providerMessageId: null, detail: "duplicate_batch_signal" });
      continue;
    }
    seen.add(key);
    const attemptedAt = Math.floor(Date.now() / 1000);
    try {
      const result = await sendDiscordSignal(signal, options);
      if (result.sent) {
        summary.sent += 1;
        await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt, result: "sent", providerMessageId: result.messageId ?? null, detail: result.channelId ? `channel_id:${result.channelId}` : null });
      } else {
        summary.skipped += 1;
        await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt, result: "skipped", providerMessageId: null, detail: result.reason || "not_sent" });
      }
    } catch (error) {
      const detail = String(error?.message || error);
      summary.failed += 1;
      summary.errors.push({ signalId: signal.id, error: detail });
      await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt, result: "failed", providerMessageId: null, detail });
      console.error("[discord] signal delivery failed", { signalId: signal.id, error: detail });
    }
  }
  return summary;
}
