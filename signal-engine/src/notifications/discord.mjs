import { env } from "../config/env.mjs";
import { ALERT_CLASSES, signalCapabilities } from "../core/signal-policy.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_SIGNAL_STATES = new Set(["whisper", "echo", "manifested", "vanished"]);
const DEFAULT_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_SAFETY_MS = 100;

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
  if (!Number.isFinite(pence)) return null;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function percent(value) {
  if (!Number.isFinite(value)) return null;
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

function rrpKindFor(signal) {
  return evidenceValue(signal, "rrp_value_kind") || null;
}

function stockLabel(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "in_stock") return "In stock";
  if (key === "low_stock") return "Low stock";
  if (key === "preorder") return "Pre-order";
  if (key === "coming_soon") return "Coming soon";
  if (key === "out_of_stock") return "Out of stock";
  return key ? key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()) : "Observed";
}

function causeLabel(value) {
  const key = String(value || "").trim().toLowerCase();
  const known = {
    restock: "Restock detected",
    availability_live: "Availability confirmed",
    new_listing_live: "New live listing",
    catalogue_new: "New catalogue listing",
    catalogue_state_change: "Catalogue state changed",
    retailer_preparation: "Retailer preparation detected",
    queue: "Queue readiness changed",
    security: "Security readiness changed",
    sold_out: "Sold out detected",
  };
  return known[key] || (key ? key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()) : null);
}

function confidenceLabel(value) {
  if (!Number.isFinite(value)) return "Not rated";
  const score = Math.max(0, Math.min(1, value));
  const band = score >= 0.85 ? "High" : score >= 0.65 ? "Moderate" : "Developing";
  return `${band} · ${Math.round(score * 100)}%`;
}

function referenceMeta(signal) {
  const kind = rrpKindFor(signal);
  const rrpKnown = Number.isFinite(signal?.rrpPence);
  if (!rrpKnown) return { kind, label: "Reference", valueLabel: null, comparator: "reference" };
  if (kind === "source_market_msrp") return { kind, label: "Official source-market MSRP", valueLabel: "Value vs reference", comparator: "reference" };
  if (kind === "source_market_component_reference") return { kind, label: "Source-market MSRP reference", valueLabel: "Value vs reference", comparator: "reference" };
  if (kind === "component_reference") return { kind, label: "Component RRP reference", valueLabel: "Value vs reference", comparator: "reference" };
  if (kind === "pack_reference") return { kind, label: "Pack RRP reference", valueLabel: "Value vs reference", comparator: "reference" };
  return { kind, label: "Official RRP", valueLabel: "Value vs RRP", comparator: "RRP" };
}

function valueLabel(signal, comparator) {
  if (!Number.isFinite(signal?.markupPercent)) return null;
  const value = percent(signal.markupPercent);
  if (!value) return null;
  const target = comparator === "RRP" ? "RRP" : "reference";
  if (signal.markupPercent < -0.5) return `${value} · BELOW ${target.toUpperCase()}`;
  if (Math.abs(signal.markupPercent) <= 0.5) return `${value} · AT ${target.toUpperCase()}`;
  return `${value} · ABOVE ${target.toUpperCase()}`;
}

function descriptionFor(signal, alertClass) {
  const primary = alertClass === ALERT_CLASSES.PRIMARY_DROP;
  const preparationEcho = signal.state === "echo" && signalKindFor(signal) === "retailer_preparation";
  if (primary) {
    if (signal.state === "whisper") return "Early retailer/SKU movement detected at a Primary/RRP retailer. Something may be coming — stock is not confirmed yet.";
    if (preparationEcho) return "Retailer preparation detected. Product/SKU infrastructure is activating, but genuine purchase availability is not confirmed yet.";
    if (signal.state === "echo") return "Readiness activity detected at a Primary/RRP retailer. Queue, traffic or security behaviour changed — get ready, but stock is not confirmed yet.";
    if (signal.state === "manifested") return "Verified purchasable stock detected at a Primary/RRP retailer. This is the live drop — go now.";
    return "This Primary/RRP offer is no longer verified purchasable. Check the product page or alternatives.";
  }

  if (signal.state === "whisper") return "New market listing/SKU movement detected. Useful market intelligence, but no live-stock claim is being made yet.";
  if (preparationEcho) return "Strong retailer preparation evidence detected. This listing appears to be getting ready, but FateDrop has not confirmed that it can be purchased yet.";
  if (signal.state === "echo") return "Market readiness activity detected. This is supporting context only; no live-stock claim is being made.";
  if (signal.state === "manifested") return "Verified market stock is live. Compare the price with FateDrop’s verified reference when available.";
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

function numericSecondsToMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

export function discordRateLimitWaitMs(response, body = "") {
  let fromBody = null;
  try {
    const parsed = typeof body === "string" && body.trim() ? JSON.parse(body) : null;
    fromBody = numericSecondsToMs(parsed?.retry_after);
  } catch {
    fromBody = null;
  }
  const fromResetAfter = numericSecondsToMs(response?.headers?.get?.("x-ratelimit-reset-after"));
  const fromRetryAfter = numericSecondsToMs(response?.headers?.get?.("retry-after"));
  const raw = fromBody ?? fromResetAfter ?? fromRetryAfter ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.max(0, Math.min(MAX_RATE_LIMIT_WAIT_MS, raw));
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
  return Boolean(signal && signal.deliverySuppressed !== true && DISCORD_SIGNAL_STATES.has(signal.state));
}

export function buildDiscordSignalMessage(signal) {
  const style = STATE_STYLE[signal.state] || STATE_STYLE.manifested;
  const alertClass = alertClassFor(signal);
  const familyLabel = FAMILY_LABEL[alertClass] || "FATEDROP";
  const productUrl = safeHttpUrl(signal.url || signal.target?.productUrl);
  const thumbnailUrl = safeHttpUrl(signal.imageUrl);
  const exactCause = signalKindFor(signal);
  const reference = referenceMeta(signal);
  const rrpReferenceBasis = evidenceValue(signal, "rrp_reference_basis");
  const priceQuality = signal.priceQuality || evidenceValue(signal, "price_quality");
  const rrpKnown = Number.isFinite(signal.rrpPence);
  const markupKnown = Number.isFinite(signal.markupPercent);
  const price = money(signal.pricePence);
  const postage = money(signal.postagePence);
  const truePrice = money(signal.deliveredPricePence);

  const fields = [
    { name: "Retailer", value: short(signal.retailerName || signal.retailerId || "Not identified", 1024), inline: true },
    { name: "Price", value: price || "Not yet available", inline: true },
    { name: "Availability", value: stockLabel(signal.stockStatus), inline: true },
  ];

  if (priceQuality === "placeholder") fields.push({ name: "Price quality", value: "Placeholder · excluded from price comparisons", inline: false });

  if (rrpKnown) {
    fields.push({ name: reference.label, value: money(signal.rrpPence) || "Not yet verified", inline: true });
    if (markupKnown && reference.valueLabel) {
      fields.push({ name: reference.valueLabel, value: valueLabel(signal, reference.comparator) || "Not yet calculable", inline: true });
    }
    if (reference.kind && reference.kind !== "official" && rrpReferenceBasis) {
      fields.push({ name: "Reference basis", value: short(rrpReferenceBasis, 1024), inline: false });
    }
  } else {
    fields.push({ name: "Reference", value: "Not yet verified", inline: true });
  }

  fields.push({ name: "Delivery", value: Number.isFinite(signal.postagePence) ? (signal.postagePence === 0 ? "Free" : postage) : "Not yet known", inline: true });
  if (Number.isFinite(signal.deliveredPricePence)) fields.push({ name: "True Price", value: truePrice, inline: true });
  if (exactCause) fields.push({ name: "Cause", value: short(causeLabel(exactCause), 1024), inline: true });
  fields.push({ name: "Confidence", value: confidenceLabel(signal.confidence), inline: true });

  const productTitle = short(signal.title || "FateDrop signal", 256);
  const embed = {
    title: short(`${style.companion} · ${style.label} · ${familyLabel}`, 256),
    description: short(`**${productTitle}**\n${descriptionFor(signal, alertClass)}`, 4096),
    color: style.colour,
    fields,
    footer: { text: short(`${style.companion} · FateDrop Signal · ${signal.id || "test"}`, 2048) },
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
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
  rateLimitSafetyMs = RATE_LIMIT_SAFETY_MS,
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

  const endpoint = `${DISCORD_API}/channels/${resolvedChannelId}/messages`;
  const request = {
    method: "POST",
    headers: { Authorization: `Bot ${resolvedBotToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildDiscordSignalMessage(signal)),
  };
  const retryLimit = Math.max(0, Math.min(10, Number(maxRateLimitRetries) || 0));
  const safetyMs = Math.max(0, Math.min(1_000, Number(rateLimitSafetyMs) || 0));
  let rateLimitRetries = 0;

  while (true) {
    const response = await fetchImpl(endpoint, request);
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      return {
        sent: true,
        messageId: payload.id ?? null,
        channelId: resolvedChannelId,
        companion: companionForSignal(signal.state),
        rateLimitRetries,
      };
    }

    const body = await response.text().catch(() => "");
    if (response.status === 429 && rateLimitRetries < retryLimit) {
      const waitMs = discordRateLimitWaitMs(response, body) + safetyMs;
      rateLimitRetries += 1;
      await sleepImpl(waitMs);
      continue;
    }
    throw new Error(`Discord delivery failed (${response.status})${body ? `: ${short(body, 300)}` : ""}`);
  }
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
        const details = [result.channelId ? `channel_id:${result.channelId}` : null, result.rateLimitRetries > 0 ? `rate_limit_retries:${result.rateLimitRetries}` : null].filter(Boolean);
        await reportDeliveryAttempt(onDeliveryAttempt, { signalId: signal.id, channel: "discord", attemptedAt, result: "sent", providerMessageId: result.messageId ?? null, detail: details.length ? details.join(";") : null });
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