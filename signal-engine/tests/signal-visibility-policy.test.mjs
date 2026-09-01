import assert from "node:assert/strict";
import test from "node:test";

import {
  applySignalBurstSafety,
  discordEligibleSignalSqlFilter,
  effectiveSignalDeliveryPolicy,
  publicSignalSqlFilter,
  signalInterruptEligible,
  signalPubliclyVisible,
  validVanishedSqlFilter,
} from "../src/core/signal-visibility-policy.mjs";
import { dispatchDiscordSignals } from "../src/notifications/discord.mjs";

function signal(index, extra = {}) {
  return {
    id: `sig-${index}`,
    state: "whisper",
    kind: "catalogue_new",
    previousPricePence: 1000,
    pricePence: 1200,
    detectedAt: 1_800_000_000 + index,
    evidence: [{ kind: "signal_kind", value: "catalogue_new" }],
    ...extra,
  };
}

test("legacy low-value Whispers remain visible in the inbox but are never Discord obligations", () => {
  const legacy = signal(1, {
    kind: undefined,
    evidence: [{ kind: "signal_kind", value: "catalogue_price_change" }],
  });
  assert.equal(effectiveSignalDeliveryPolicy(legacy), "inbox_only");
  assert.equal(signalPubliclyVisible(legacy), true);
  assert.equal(signalInterruptEligible(legacy), false);
});

test("history anchors and anomaly quarantine are hidden while normal signals remain public", () => {
  const history = signal(1, { evidence: [{ kind: "delivery_policy", value: "history_only" }] });
  const anomaly = signal(2, { evidence: [{ kind: "delivery_policy", value: "anomaly_quarantine" }] });
  assert.equal(signalPubliclyVisible(history), false);
  assert.equal(signalPubliclyVisible(anomaly), false);
  assert.equal(signalPubliclyVisible(signal(3)), true);
});

test("coherent catalogue-wide price steps are quarantined without suppressing Manifested truth", () => {
  const priceSignals = Array.from({ length: 30 }, (_, index) => signal(index, {
    kind: "catalogue_price_change",
    evidence: [{ kind: "signal_kind", value: "catalogue_price_change" }],
  }));
  const manifested = signal(99, { state: "manifested", kind: "restock", evidence: [{ kind: "signal_kind", value: "restock" }] });
  const result = applySignalBurstSafety([...priceSignals, manifested]);
  assert.equal(result.diagnostics.quarantined, 30);
  assert.equal(result.signals.filter((item) => effectiveSignalDeliveryPolicy(item) === "anomaly_quarantine").length, 30);
  assert.equal(effectiveSignalDeliveryPolicy(result.signals.find((item) => item.id === manifested.id)), "interrupt");
});

test("large Whisper interrupt bursts keep the safe interrupt budget and hold only the excess", () => {
  const result = applySignalBurstSafety(Array.from({ length: 26 }, (_, index) => signal(index)));
  assert.equal(result.diagnostics.burstHeld, 1);
  assert.equal(result.signals.filter((item) => effectiveSignalDeliveryPolicy(item) === "interrupt").length, 25);
  assert.equal(result.signals.filter((item) => effectiveSignalDeliveryPolicy(item) === "inbox_only").length, 1);
  assert.match(result.signals.at(-1).evidence.find((entry) => entry.kind === "delivery_policy_reason")?.value || "", /cap_25/);
});

test("central SQL policy applies the same legacy inference and persisted Vanished proof everywhere", () => {
  assert.match(publicSignalSqlFilter("s"), /history_only/);
  assert.match(publicSignalSqlFilter("s"), /anomaly_quarantine/);
  assert.match(discordEligibleSignalSqlFilter("s"), /catalogue_price_change/);
  assert.match(discordEligibleSignalSqlFilter("s"), /= 'interrupt'/);
  assert.match(validVanishedSqlFilter("s"), /prior_live_confirmation/);
  assert.match(validVanishedSqlFilter("s"), /persisted_purchasable_offer/);
});

test("Discord records deliberate policy skips so they never become telemetry orphans", async () => {
  const attempts = [];
  const outcome = await dispatchDiscordSignals([
    signal(1, { kind: "catalogue_price_change", evidence: [{ kind: "signal_kind", value: "catalogue_price_change" }] }),
  ], {
    onDeliveryAttempt: async (attempt) => attempts.push(attempt),
  });
  assert.equal(outcome.skipped, 1);
  assert.equal(outcome.sent, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].result, "skipped");
  assert.equal(attempts[0].detail, "policy_inbox_only");
});
