import assert from "node:assert/strict";
import test from "node:test";
import { dispatchNotificationOutbox } from "../src/hosted/notification-dispatch.mjs";

const outbox = (overrides = {}) => ({
  id: "out_1",
  user_id: "user_1",
  event_type: "fate_match",
  event_id: "fm_1",
  channel: "push",
  title: "Koru found it",
  body: "A FateFind matched.",
  url: "https://example.test/product",
  payload_json: {},
  state: "pending",
  attempts: 0,
  next_attempt_at: 100,
  created_at: 90,
  updated_at: 90,
  ...overrides,
});

test("hosted dispatcher only claims FateMatch outbox rows, leaving lifecycle push to its canonical worker", async () => {
  const candidate = outbox();
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith("SELECT * FROM fatedrop_notification_outbox")) return { rows: [candidate] };
      if (sql.startsWith("UPDATE fatedrop_notification_outbox SET state='sending'")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await dispatchNotificationOutbox(pool, { now: 100, fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(result, { attempted: 0, sent: 0, failed: 0, suppressed: 0 });
  assert.match(queries[0], /event_type='fate_match'/);
  assert.match(queries[1], /event_type='fate_match'/);
});

test("dispatch skips delivery when another worker already claimed the outbox row", async () => {
  const candidate = outbox();
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith("SELECT * FROM fatedrop_notification_outbox")) return { rows: [candidate] };
      if (sql.startsWith("UPDATE fatedrop_notification_outbox SET state='sending'")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  let fetched = false;
  const result = await dispatchNotificationOutbox(pool, {
    now: 100,
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, failed: 0, suppressed: 0 });
  assert.equal(fetched, false);
  assert.match(queries[1], /state IN \('pending','failed'\)/);
  assert.match(queries[1], /RETURNING \*/);
});

test("DeviceNotRegistered disables the endpoint and suppresses the outbox without retrying", async () => {
  const candidate = outbox();
  const claimed = { ...candidate, state: "sending", attempts: 1, updated_at: 100 };
  const writes = [];
  const pool = {
    async query(sql, params = []) {
      if (sql.startsWith("SELECT * FROM fatedrop_notification_outbox")) return { rows: [candidate] };
      if (sql.startsWith("UPDATE fatedrop_notification_outbox SET state='sending'")) return { rows: [claimed] };
      if (sql.startsWith("SELECT * FROM fatedrop_push_endpoints")) return { rows: [{ id: "push_1", expo_push_token: "ExponentPushToken[test]" }] };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: {
          status: "error",
          message: "The recipient device is not registered with FCM.",
          details: { error: "DeviceNotRegistered" },
        },
      };
    },
  });

  const result = await dispatchNotificationOutbox(pool, { now: 100, fetchImpl });

  assert.deepEqual(result, { attempted: 1, sent: 0, failed: 0, suppressed: 1 });
  const endpointWrite = writes.find(({ sql }) => sql.startsWith("UPDATE fatedrop_push_endpoints SET last_failure_at"));
  assert.ok(endpointWrite);
  assert.equal(endpointWrite.params[3], true);
  assert.match(endpointWrite.params[2], /^DeviceNotRegistered:/);
  const suppressedWrite = writes.find(({ sql }) => sql.includes("SET state='suppressed'"));
  assert.ok(suppressedWrite);
  assert.equal(writes.some(({ sql }) => sql.includes("SET state='failed'")), false);
});
