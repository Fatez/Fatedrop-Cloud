import { env } from "../config/env.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_SIGNAL_STATES = new Set(["whisper", "manifested", "vanished", "echo"]);

const STATE_STYLE = Object.freeze({
  whisper: {
    label: "WHISPER",
    colour: 0xf59e0b,
    fallback: "Early catalogue change detected before verified availability.",
  },
  manifested: {
    label: "MANIFESTED",
    colour: 0x7c3aed,
    fallback: "Verified purchasable stock detected.",
  },
  vanished: {
    label: "VANISHED",
    colour: 0xef4444,
    fallback: "Previously purchasable stock is no longer verified available.",
  },
  echo: {
    label: "ECHO",
    colour: 0x22d3ee,
    fallback: "Previously available stock has returned.",
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

export function isDiscordSignal(signal) {
  return Boolean(signal && DISCORD_SIGNAL_STATES.has(signal.state));
}

export function buildDiscordSignalMessage(signal) {
  const style = STATE_STYLE[signal.state] || STATE_STYLE.manifested;
  const productUrl = safeHttpUrl(signal.url);
  const thumbnailUrl = safeHttpUrl(signal.imageUrl);
  const confidence = Number.isFinite(signal.confidence) ? `${Math.round(signal.confidence * 100)}%` : "Unknown";
  const delivered = Number.isFinite(signal.deliveredPricePence) ? money(signal.deliveredPricePence) : "Not confirmed";

  const fields = [
    { name: "Retailer", value: short(signal.retailerName || signal.retailerId || "Unknown", 1024), inline: true },
    { name: "Price", value: money(signal.pricePence), inline: true },
    { name: "RRP", value: money(signal.rrpPence), inline: true },
    { name: "Markup vs RRP", value: percent(signal.markupPercent), inline: true },
    { name: "Delivered price", value: delivered, inline: true },
    { name: "Signal confidence", value: confidence, inline: true },
  ];

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

  const message = {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };

  if (productUrl) {
    message.components = [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: "View retailer",
        url: productUrl,
      }],
    }];
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
  if (!enabled) return { sent: false, reason: "disabled" };
  if (!botToken || !channelId) return { sent: false, reason: "not_configured" };

  const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
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
  for (const signal of signals || []) {
    if (!isDiscordSignal(signal)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await sendDiscordSignal(signal, options);
      if (result.sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ signalId: signal.id, error: String(error?.message || error) });
      console.error("[discord] signal delivery failed", { signalId: signal.id, error: String(error?.message || error) });
    }
  }
  return summary;
}
