import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSignalHealthSummary } from '../src/telemetry/signal-health-summary.mjs';

test('Discord reliability ignores canonical history-only lifecycle anchors', async () => {
  const seen = [];
  const now = 1_800_000_000;
  const query = async (sql) => {
    seen.push(sql);
    if (sql.includes('latest_signal_at')) {
      return { rows: [{ latest_signal_at: null, latest_discord_attempt_at: null, recent_signals: 0, recent_discord_attempts: 0 }] };
    }
    if (sql.includes('fatedrop_retailer_discovery_evidence')) {
      return { rows: [{ discovery_available: true, pending: 0, retry: 0, processed: 0, failed: 0, latest_observed_at: null, latest_processed_at: null, oldest_active_at: null }] };
    }
    return { rows: [] };
  };
  const store = {
    pool: async () => ({ query }),
    listNetworkSnapshots: async () => [],
    listRetailers: async () => [],
  };

  await loadSignalHealthSummary(store, { days: 2, now });

  const orphanSql = seen.find((sql) => sql.includes('ORDER BY s.detected_at ASC LIMIT 100'));
  const freshnessSql = seen.find((sql) => sql.includes('latest_signal_at'));
  assert.ok(orphanSql, 'orphan reliability query should execute');
  assert.ok(freshnessSql, 'freshness reliability query should execute');
  assert.match(orphanSql, /delivery_policy->>'kind'='delivery_policy'/);
  assert.match(orphanSql, /delivery_policy->>'value'='history_only'/);
  assert.equal((freshnessSql.match(/delivery_policy->>'value'='history_only'/g) || []).length, 2);
  assert.match(freshnessSql, /MAX\(s\.detected_at\)/);
  assert.match(freshnessSql, /COUNT\(\*\)::int FROM fatedrop_signals s/);
});
