import assert from 'node:assert/strict';
import test from 'node:test';

import { listCanonicalLocalRadarChainAlerts } from '../src/telemetry/public-local-radar-chain-alerts.mjs';

function storeFor(rows, capture = {}) {
  return {
    async pool() {
      return {
        async query(sql, values) {
          capture.sql = sql;
          capture.values = values;
          return { rows };
        },
      };
    },
  };
}

test('branchless retailer-chain staff Echo becomes a visible canonical advisory alert without branch or product fabrication', async () => {
  const capture = {};
  const alerts = await listCanonicalLocalRadarChainAlerts(storeFor([{
    id: 'lse_smyths_chain_echo',
    kind: 'echo',
    retailer_id: 'smyths-uk',
    retailer_name: 'Smyths Toys UK',
    occurred_at: 1788130500,
    evidence_json: {
      localIntel: true,
      advisory: true,
      scope: 'retailer_chain',
      evidenceLevel: 'inventory_preparation',
      sourceType: 'retailer_staff_report',
      sourceLabel: 'Smyths manager report',
      rawProductTitle: 'Pokémon TCG: Destined Rivals ETBs + Temporal Forces',
      expectedFrom: '2026-08-31T00:00:00+01:00',
      expectedTo: '2026-08-31T23:59:59+01:00',
      expectedLabel: 'Expected Monday 31 August',
      confidence: 0.68,
      availabilityVerified: false,
      branchVerified: false,
    },
  }], capture), { limit: 50 });

  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.fateStage, 'ECHO');
  assert.equal(alert.type, 'ECHO');
  assert.equal(alert.retailerId, 'smyths-uk');
  assert.equal(alert.retailer, 'Smyths Toys UK');
  assert.equal(alert.title, 'Pokémon TCG: Destined Rivals ETBs + Temporal Forces');
  assert.equal(alert.productId, null);
  assert.equal(alert.offerId, null);
  assert.equal(alert.productUrl, null);
  assert.equal(alert.confirmed, false);
  assert.equal(alert.confirmedRestock, false);
  assert.equal(alert.productIntelligence.category, 'SEALED_TCG');
  assert.equal(alert.localRadar.advisory, true);
  assert.equal(alert.localRadar.scope, 'retailer_chain');
  assert.equal(alert.localRadar.physicalStockConfirmed, false);
  assert.equal(alert.localRadar.branchResolved, false);
  assert.match(alert.message, /Expected Monday 31 August at participating Smyths Toys UK stores\./);
  assert.match(alert.message, /Exact participating branches are still being resolved\./);
  assert.match(alert.message, /Physical stock is not confirmed yet\./);
  assert.equal(alert.signalThread[0].stockStatus, 'expected');
  assert.equal(alert.priceIntelligence.verdict, 'NO_FAIR_COMPARISON');

  assert.match(capture.sql, /FROM fatedrop_signal_events se/);
  assert.match(capture.sql, /se\.location_id IS NULL/);
  assert.match(capture.sql, /se\.kind IN \('whisper','echo'\)/);
  assert.match(capture.sql, /evidence_json->>'localIntel'/);
  assert.match(capture.sql, /evidence_json->>'scope'='retailer_chain'/);
});

test('chain advisory alert lookup remains id scoped and bounded', async () => {
  const capture = {};
  await listCanonicalLocalRadarChainAlerts(storeFor([], capture), { id: 'specific-chain-event', limit: 500 });
  assert.deepEqual(capture.values, ['specific-chain-event', 100]);
  assert.match(capture.sql, /\(\$1::text IS NULL OR se\.id=\$1\)/);
});
