import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSignalDeliveryOutbox } from "../src/notifications/signal-outbox.mjs";

const NOW = 2_000_000;

function outboxRow() {
  return {
    id: "outbox_1",
    idempotency_key: "lifecycle:v1:sig_1:discord:lifecycle:manifested",
    signal_id: "sig_1",
    episode_id: "episode_1",
    channel: "discord",
    destination_key: "lifecycle:manifested",
    delivery_policy: "interrupt",
    state: "pending",
    attempt_count: 0,
    available_at: NOW,
    expires_at: NOW + 900,
    lease_token: null,
    lease_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function signalRow() {
  return {
    id: "sig_1",
    state: "manifested",
    product_id: "prod_1",
    offer_id: "offer_1",
    retailer_id: "retailer_1",
    retailer_name: "Retailer",
    title: "Product",
    product_type: "booster_pack",
    url: "https://example.com/product",
    image_url: null,
    price_pence: 499,
    rrp_pence: 429,
    postage_pence: 0,
    delivered_price_pence: 499,
    markup_percent: 16.3,
    stock_status: "in_stock",
    previous_stock_status: "out_of_stock",
    confidence: 0.98,
    detected_at: NOW,
    reason: "verified",
    evidence: [],
  };
}

class FakePool {
  constructor() {
    this.outbox = outboxRow();
    this.signal = signalRow();
    this.attempts = [];
    this.legacyAttempts = [];
    this.superseded = false;
  }

  async query(sql, values = []) {
    if (sql.includes("lease_expired_after_provider_boundary") && sql.startsWith("UPDATE")) return { rows: [] };
    if (sql.includes("expired_before_delivery") && sql.startsWith("UPDATE")) {
      if (["pending", "retryable"].includes(this.outbox.state) && this.outbox.expires_at < values[0]) {
        this.outbox.state = "dead_letter";
        return { rows: [{ id: this.outbox.id }] };
      }
      return { rows: [] };
    }
    if (sql.includes("superseded_by_newer_episode_event") && sql.startsWith("UPDATE")) {
      if (this.superseded && ["pending", "retryable"].includes(this.outbox.state)) {
        this.outbox.state = "suppressed";
        this.outbox.last_error = "superseded_by_newer_episode_event";
        return { rows: [{ id: this.outbox.id }] };
      }
      return { rows: [] };
    }
    if (sql.includes("WITH candidate AS")) {
      const [now, leaseToken, leaseExpiresAt] = values;
      if (!["pending", "retryable"].includes(this.outbox.state)
        || this.outbox.available_at > now
        || this.outbox.expires_at < now) return { rows: [] };
      this.outbox = {
        ...this.outbox,
        state: "claimed",
        attempt_count: this.outbox.attempt_count + 1,
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      };
      return { rows: [{ ...this.outbox }] };
    }
    if (sql.startsWith("SELECT * FROM fatedrop_signals")) return { rows: [{ ...this.signal }] };
    throw new Error(`Unexpected pool query: ${sql}`);
  }

  async connect() {
    return {
      query: async (sql, values = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
        if (sql.startsWith("SELECT * FROM fatedrop_signal_delivery_outbox")) return { rows: [{ ...this.outbox }] };
        if (sql.includes("INSERT INTO fatedrop_signal_delivery_outbox_attempts")) {
          this.attempts.push({ values });
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE fatedrop_signal_delivery_outbox")) {
          const [, state, availableAt, providerMessageId, updatedAt, lastError] = values;
          this.outbox = {
            ...this.outbox,
            state,
            available_at: availableAt,
            provider_message_id: providerMessageId || this.outbox.provider_message_id || null,
            accepted_at: state === "provider_accepted" ? updatedAt : this.outbox.accepted_at,
            updated_at: updatedAt,
            last_error: state === "provider_accepted" ? null : lastError,
            lease_token: null,
            lease_expires_at: null,
          };
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO fatedrop_signal_delivery_attempts")) {
          this.legacyAttempts.push({ values });
          return { rows: [] };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() {},
    };
  }
}

function storeFor(pool) {
  return { async pool() { return pool; } };
}

test("parallel workers claim one FateDrop ledger obligation exactly once", async () => {
  const pool = new FakePool();
  let providerCalls = 0;
  const send = async () => {
    providerCalls += 1;
    return { sent: true, messageId: "discord_1", channelId: "channel_1" };
  };
  const options = { limit: 1, now: NOW, sendDiscordSignalFn: send };
  const [left, right] = await Promise.all([
    dispatchSignalDeliveryOutbox(storeFor(pool), options),
    dispatchSignalDeliveryOutbox(storeFor(pool), options),
  ]);
  assert.equal(providerCalls, 1);
  assert.equal(left.claimed + right.claimed, 1);
  assert.equal(pool.outbox.state, "provider_accepted");
  assert.equal(pool.outbox.provider_message_id, "discord_1");
  assert.equal(pool.attempts.length, 1);
  assert.equal(pool.legacyAttempts.length, 1);
});

test("superseded lifecycle evidence is suppressed before any provider call", async () => {
  const pool = new FakePool();
  pool.superseded = true;
  let providerCalls = 0;
  const result = await dispatchSignalDeliveryOutbox(storeFor(pool), {
    limit: 1,
    now: NOW,
    sendDiscordSignalFn: async () => {
      providerCalls += 1;
      return { sent: true };
    },
  });
  assert.equal(result.supersededObligations, 1);
  assert.equal(result.claimed, 0);
  assert.equal(providerCalls, 0);
  assert.equal(pool.outbox.state, "suppressed");
});

test("ambiguous provider outcome is quarantined and never blindly retried", async () => {
  const pool = new FakePool();
  let providerCalls = 0;
  const send = async () => {
    providerCalls += 1;
    throw new Error("socket closed after request write");
  };
  const first = await dispatchSignalDeliveryOutbox(storeFor(pool), { limit: 1, now: NOW, sendDiscordSignalFn: send });
  const second = await dispatchSignalDeliveryOutbox(storeFor(pool), { limit: 1, now: NOW + 60, sendDiscordSignalFn: send });
  assert.equal(first.unknown, 1);
  assert.equal(second.claimed, 0);
  assert.equal(providerCalls, 1);
  assert.equal(pool.outbox.state, "outcome_unknown");
});

test("authoritative provider rejection retries through the same idempotent obligation", async () => {
  const pool = new FakePool();
  let providerCalls = 0;
  const send = async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      const error = new Error("Discord delivery failed (503)");
      error.status = 503;
      throw error;
    }
    return { sent: true, messageId: "discord_2", channelId: "channel_1" };
  };
  const first = await dispatchSignalDeliveryOutbox(storeFor(pool), { limit: 1, now: NOW, sendDiscordSignalFn: send });
  const tooSoon = await dispatchSignalDeliveryOutbox(storeFor(pool), { limit: 1, now: NOW + 10, sendDiscordSignalFn: send });
  const retry = await dispatchSignalDeliveryOutbox(storeFor(pool), { limit: 1, now: NOW + 31, sendDiscordSignalFn: send });
  assert.equal(first.retryable, 1);
  assert.equal(tooSoon.claimed, 0);
  assert.equal(retry.sent, 1);
  assert.equal(providerCalls, 2);
  assert.equal(pool.outbox.state, "provider_accepted");
  assert.equal(pool.outbox.attempt_count, 2);
});
