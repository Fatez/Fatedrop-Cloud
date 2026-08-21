import { env } from "../config/env.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_SIGNAL_STATES = new Set(["whisper", "echo", "manifested", "vanished"]);

const STATE_STYLE = Object.freeze({
  whisper: {
    publicStage: "Whisper",
    label: "WHISPER",
    colour: 0x67e8f9,
    fallback: "Product or catalogue movement detected. Something may be coming.",
    actionLabel: "Inspect product",
  },
  echo: {
    publicStage: "Echo",
    label: "ECHO",
    colour: 0xa855f7,
    fallback: "Traffic, queue or security behaviour changed. Get ready for possible stock activity.",
    actionLabel: "Get ready / inspect",
  },
  manifested: {
    publicStage: "Manifested",
    label: "MANIFESTED",
    colour: 0x49e6b1,
    fallback: "Confirmed purchasable stock detected. Go now.",
    actionLabel: "Buy / view product",
  },
  vanished: {
    publicStage: "Vanished",
    label: "VANISHED",
    colour: 0xff647c,
    fallback: "Previously purchasable stock is no longer confirmed available.",
    actionLabel: "View product / alternatives",
  },
});

function money(pence) {
  if (!Number.isFinite(pence)) return "Unknown";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function percent(value) {
  if (!Number.isFinite(value)) return "Unknown";
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

export function isDiscordSignal(signal) {
  return Boolean(signal && DISCORD_SIGNAL_STATES.has(signal.state));
}

export function buildDiscordSignalMessage(signal) {
  const style = STATE_STYLE[signal.state] || STATE_STYLE.manifested;
  const productUrl = safeHttpUrl(signal.url || signal.target?.productUrl);
  const thumbnailUrl = safeHttpUrl(signal.imageUrl);
  const confidence = Number.isFinite(signal.confidence) ? `${Math.round(signal.confidence * 100)}%` : "Unknown";

  const fields = [
    { name: "Retailer", value: short(signal.retailerName || signal.retailerId || "Unknown", 1024), inline: true },
    { name: "Price", value: money(signal.pricePence), inline: true },
    { name: "Stock", value: short(signal.stockStatus || "Unknown", 1024), inline: true },
  ];

  if (Number.isFinite(signal.rrpPence)) fields.push({ name: "Official RRP", value: money(signal.rrpPence), inline: true });
  if (Number.isFinite(signal.markupPercent)) fields.push({ name: "Vs RRP", value: percent(signal.markupPercent), inline: true });
  if (Number.isFinite(signal.deliveredPricePence)) fields.push({ name: "Delivered price", value: money(signal.deliveredPricePence), inline: true });
  fields.push({ name: "Signal confidence", value: confidence, inline: true });

  const embed = {
    title: short(`${style.label} · ${signal.title || "FateDrop signal"}`, 256),
    description: short(signal.reason || style.fallback, 4096),
    color: style.colour,
    fields,
    footer: { text: short(`FateDrop Signal · ${signal.id || "test"}`, 2048) },
    timestamp: new Date((signal.detectedAt || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };

  if (productUrl) embed.url = productUrl;
  if (thumbnailUrl) embed.thumbnail = { url: thumbnailUrl };

  const message = { embeds: [embed], allowed_mentions: { parse: [] } };
  if (productUrl) {
    message.components = [{ type: 1, components: [{ type: 2, style: 5, label: style.actionLabel, url: productUrl }] }];
  }
  return message;
}

export async function sendDiscordSignal(signal, {
  fetchImpl = fetch,
  enabled = env.discord.enabled,
  botToken = env.discord.botToken,
  channelId = env.discord.premiumDropsChannelId,
} = {}) {
  if (!isDiscordSignal(signal)) return { sent: false, reason: "state_not_enabled" };
  if (!botToken) return { sent: false, reason: "missing_bot_token" };
  if (!channelId) return { sent: false, reason: "missing_channel_id" };
  if (!enabled) return { sent: false, reason: "disabled" };

  const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildDiscordSignalMessage(signal)),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord delivery failed (${response.status})${body ? `: ${short(body, 300)}` : ""}`);
  }

  const payload = await response.json().catch(() => ({}));
  return { sent: true, messageId: payload.id ?? null };
}

export async function dispatchDiscordSignals(signals, options = {}) {
  const summary = { sent: 0, skipped: 0, failed: 0, errors: [] };
  const onDeliveryAttempt = options.onDeliveryAttempt;
  for (const signal of signals || []) {
    if (!isDiscordSignal(signal)) { summary.skipped += 1; continue; }
    const attemptedAt = Math.floor(Date.now() / 1000);
    try {
      const result = await sendDiscordSignal(signal, options);
      if (result.sent) {
        summary.sent += 1;
        await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt, result: "sent", providerMessageId: result.messageId ?? null, detail: null });
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
