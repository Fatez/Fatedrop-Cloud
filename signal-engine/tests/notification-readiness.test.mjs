import test from "node:test";
import assert from "node:assert/strict";
import { buildFateMatchNotificationReadiness, normalizeNotificationReadiness } from "../src/hosted/notification-readiness.mjs";

test("notification readiness fails closed when FateMatch delivery is overdue or stuck", () => {
  const snapshot = normalizeNotificationReadiness({ total: "8", sent: "4", suppressed: "1", pending: "1", failed: "1", sending: "1", overdue: "1", stuck_sending: "1" }, { since: 100, now: 200 });
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.total, 8);
  assert.equal(snapshot.overdue, 1);
  assert.equal(snapshot.stuckSending, 1);
});

test("notification readiness is green when no FateMatch rows are overdue or stuck", () => {
  const snapshot = normalizeNotificationReadiness({ total: 5, sent: 4, suppressed: 1, pending: 0, failed: 0, sending: 0, overdue: 0, stuck_sending: 0 }, { since: 100, now: 200 });
  assert.equal(snapshot.ready, true);
});

test("readiness query applies grace windows to overdue and sending rows", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ total: 3, sent: 2, suppressed: 0, pending: 1, failed: 0, sending: 0, overdue: 0, stuck_sending: 0 }] };
    },
  };
  const snapshot = await buildFateMatchNotificationReadiness(pool, { now: 1000, since: 100, overdueGraceSeconds: 120, sendingGraceSeconds: 300 });
  assert.equal(snapshot.ready, true);
  assert.deepEqual(calls[0].params, [100, 880, 700]);
  assert.match(calls[0].sql, /event_type='fate_match'/);
  assert.match(calls[0].sql, /next_attempt_at <= \$2/);
  assert.match(calls[0].sql, /updated_at <= \$3/);
});
