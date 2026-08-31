import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { listCanonicalPublicAlerts } from '../src/telemetry/public-alert-contract.mjs';

const alertSource = await readFile(new URL('../src/telemetry/public-alert-contract.mjs', import.meta.url), 'utf8');

function manifestedRow(extra = {}) {
  return {
    id: 'sig_manifested_1',
    state: 'manifested',
    product_id: 'prd_1',
    offer_id: 'off_1',
    retailer_id: 'chaos-cards',
    retailer_name: 'Chaos Cards',
    title: 'Example ETB',
    product_type: 'elite_trainer_box',
    url: 'https://example.test/product',
    image_url: null,
    price_pence: 4999,
    signal_rrp_pence: null,
    canonical_rrp_pence: null,
    delivered_price_pence: null,
    stock_status: 'in_stock',
    confidence: 0.99,
    detected_at: 100,
    live_manifested_at: 100,
    last_confirmed_live_at: 190,
    observed_duration_seconds: null,
    reason: 'Confirmed purchasable retailer SKU',
    evidence: [],
    history_json: [],
    alternatives_json: [],
    lowest_offer_id: null,
    official_offer_id: null,
    delivery_policy: 'interrupt',
    ...extra,
  };
}

function storeReturning(row) {
  return {
    async pool() {
      return {
        async query() {
          return { rows: [row] };
        },
      };
    },
  };
}

test('active Manifested exposes only a current open-ended live window', async () => {
  const [alert] = await listCanonicalPublicAlerts(storeReturning(manifestedRow()), { state: 'manifested', limit: 1 });
  assert.equal(alert.fateStage, 'MANIFESTED');
  assert.equal(alert.confirmed, true);
  assert.equal(alert.interruptEligible, true);
  assert.deepEqual(alert.liveWindow, {
    manifestedAt: '1970-01-01T00:01:40.000Z',
    lastConfirmedLiveAt: '1970-01-01T00:03:10.000Z',
    vanishedAt: null,
    observedDurationSeconds: null,
    historyComplete: false,
  });
});

test('Manifested live window fails closed without a fresh confirmation', async () => {
  const [alert] = await listCanonicalPublicAlerts(storeReturning(manifestedRow({ last_confirmed_live_at: null })), { state: 'manifested', limit: 1 });
  assert.equal(alert.liveWindow.manifestedAt, '1970-01-01T00:01:40.000Z');
  assert.equal(alert.liveWindow.lastConfirmedLiveAt, null);
  assert.equal(alert.liveWindow.vanishedAt, null);
});

test('Manifested live window rejects confirmation older than the canonical episode start', async () => {
  const [alert] = await listCanonicalPublicAlerts(storeReturning(manifestedRow({ last_confirmed_live_at: 90 })), { state: 'manifested', limit: 1 });
  assert.equal(alert.liveWindow.lastConfirmedLiveAt, null);
});

test('Whisper and Echo still never expose a live window', async () => {
  for (const state of ['whisper', 'echo']) {
    const [alert] = await listCanonicalPublicAlerts(storeReturning(manifestedRow({ state })), { state, limit: 1 });
    assert.equal(alert.liveWindow, null);
  }
});

test('active Manifested freshness is gated by canonical episode and trusted current-offer evidence', () => {
  assert.match(alertSource, /s\.state='manifested' AND canonical_episode\.availability_state='available' AND canonical_episode\.vanished_at IS NULL/);
  assert.match(alertSource, /THEN canonical_episode\.manifested_at/);
  assert.match(alertSource, /ro\.offer_id=s\.offer_id/);
  assert.match(alertSource, /ro\.retailer_id=s\.retailer_id/);
  assert.match(alertSource, /ro\.stock_status IN \('in_stock','low_stock','preorder'\)/);
  assert.match(alertSource, /ro\.last_seen_at >= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint - 1800/);
  assert.match(alertSource, /ro\.last_seen_at <= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint \+ 300/);
  assert.match(alertSource, /ro\.stock_confidence IS NULL OR ro\.stock_confidence >= 0\.9/);
  assert.match(alertSource, /rh\.healthy=true/);
  assert.match(alertSource, /COALESCE\(rh\.last_success_at,rh\.last_scan_at\) >= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint - 1800/);
});

test('Vanished live-window derivation remains explicitly isolated from active Manifested proof', () => {
  assert.match(alertSource, /WHERE s\.state='vanished'/);
  assert.match(alertSource, /evidence_item->>'kind'='prior_live_confirmation'/);
  assert.match(alertSource, /evidence_item->>'value'='persisted_purchasable_offer'/);
  assert.match(alertSource, /CASE WHEN s\.state='vanished' AND live_window\.manifested_at IS NOT NULL/);
});
