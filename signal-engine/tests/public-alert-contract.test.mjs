import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { listCanonicalPublicAlerts } from '../src/telemetry/public-alert-contract.mjs';

const alertSource = await readFile(new URL('../src/telemetry/public-alert-contract.mjs', import.meta.url), 'utf8');
const signalSource = await readFile(new URL('../src/telemetry/public-signal-contract.mjs', import.meta.url), 'utf8');

function vanishedRow(extra = {}) {
  return {
    id: 'sig_vanished_1',
    state: 'vanished',
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
    stock_status: 'out_of_stock',
    confidence: 0.99,
    detected_at: 200,
    live_manifested_at: 100,
    last_confirmed_live_at: 190,
    observed_duration_seconds: 100,
    reason: 'Previously confirmed purchasable retailer SKU is no longer verified available',
    evidence: [],
    history_json: [],
    alternatives_json: [],
    lowest_offer_id: null,
    official_offer_id: null,
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

test('public signal contract exposes opt-in rich Alerts without reopening diagnostics', () => {
  assert.match(signalSource, /detail === 'alerts'/);
  assert.match(signalSource, /listCanonicalPublicAlerts/);
  assert.match(signalSource, /contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION/);
  assert.match(signalSource, /source: 'FATEDROP_CLOUD'/);
  assert.doesNotMatch(signalSource, /api\/status/);
  assert.doesNotMatch(signalSource, /api\/signal-health/);
});

test('Cloud owns alert RRP, best-offer, alternatives and exact Vanished history', () => {
  assert.match(alertSource, /official_rrp_pence/);
  assert.match(alertSource, /fatedrop_retail_offers/);
  assert.match(alertSource, /JOIN fatedrop_retailer_health rh ON rh\.retailer_id=ro\.retailer_id/);
  assert.match(alertSource, /rh\.healthy=true/);
  assert.match(alertSource, /COALESCE\(rh\.last_success_at,rh\.last_scan_at\) >= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint - 1800/);
  assert.match(alertSource, /WHERE hs\.offer_id=s\.offer_id/);
  assert.match(alertSource, /WHERE ro\.product_id=s\.product_id AND ro\.offer_id<>s\.offer_id/);
  assert.match(alertSource, /ro\.retailer_id='pokemon-center-uk'/);
  assert.match(alertSource, /BETTER_OFFER_FOUND/);
  assert.match(alertSource, /LOWEST_KNOWN/);
  assert.match(alertSource, /NO_FAIR_COMPARISON/);
});

test('history-only Manifested anchors remain lifecycle evidence but never occupy the public inbox window', () => {
  assert.match(alertSource, /delivery_policy->>'kind'='delivery_policy'/);
  assert.match(alertSource, /delivery_policy->>'value'='history_only'/);
  assert.match(alertSource, /AND NOT EXISTS \(\s*SELECT 1\s*FROM jsonb_array_elements/);
  assert.match(alertSource, /hs\.state='manifested'/);
  assert.match(alertSource, /ORDER BY hs\.detected_at DESC/);
});

test('Vanished stays fail-closed but accepts canonical persisted prior-live proof when baseline suppressed the Manifested alert row', () => {
  assert.match(alertSource, /evidence_item->>'kind'='prior_live_confirmation'/);
  assert.match(alertSource, /evidence_item->>'value'='persisted_purchasable_offer'/);
  assert.match(alertSource, /evidence_item->>'observedAt'/);
  assert.match(alertSource, /live_window\.manifested_at IS NOT NULL OR persisted_live\.persisted_prior_live IS TRUE/);
  assert.match(alertSource, /CASE WHEN s\.state='vanished' AND live_window\.manifested_at IS NOT NULL THEN GREATEST\(0,s\.detected_at-live_window\.manifested_at\) ELSE NULL END/);
  assert.match(alertSource, /live_window\.manifested_at AS live_manifested_at/);
  assert.match(alertSource, /\(evidence_item->>'observedAt'\)::bigint AS last_confirmed_live_at/);
  assert.doesNotMatch(alertSource, /s\.state <> 'vanished' OR TRUE/);
  assert.doesNotMatch(alertSource, /firstAvailableAt|everAvailableAt|ever_available_at/);
});

test('complete Vanished history exposes the canonical current live window', async () => {
  const [alert] = await listCanonicalPublicAlerts(storeReturning(vanishedRow()), { state: 'vanished', limit: 1 });
  assert.equal(alert.observedDurationSeconds, 100);
  assert.deepEqual(alert.liveWindow, {
    manifestedAt: '1970-01-01T00:01:40.000Z',
    lastConfirmedLiveAt: '1970-01-01T00:03:10.000Z',
    vanishedAt: '1970-01-01T00:03:20.000Z',
    observedDurationSeconds: 100,
    historyComplete: true,
  });
});

test('legacy Vanished without a supported Manifested start remains explicitly incomplete', async () => {
  const row = vanishedRow({ live_manifested_at: null, observed_duration_seconds: null });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'vanished', limit: 1 });
  assert.equal(alert.observedDurationSeconds, null);
  assert.deepEqual(alert.liveWindow, {
    manifestedAt: null,
    lastConfirmedLiveAt: '1970-01-01T00:03:10.000Z',
    vanishedAt: '1970-01-01T00:03:20.000Z',
    observedDurationSeconds: null,
    historyComplete: false,
  });
});

test('invalid live-window ordering fails closed instead of inventing a last-live timestamp', async () => {
  const row = vanishedRow({ last_confirmed_live_at: 90 });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'vanished', limit: 1 });
  assert.equal(alert.liveWindow.manifestedAt, '1970-01-01T00:01:40.000Z');
  assert.equal(alert.liveWindow.lastConfirmedLiveAt, null);
  assert.equal(alert.liveWindow.vanishedAt, '1970-01-01T00:03:20.000Z');
  assert.equal(alert.liveWindow.historyComplete, false);
});

test('Cloud alert output preserves the final four-stage lifecycle and prepared links', () => {
  assert.match(alertSource, /state === 'whisper'\) return 'WHISPER'/);
  assert.match(alertSource, /state === 'echo'\) return 'ECHO'/);
  assert.match(alertSource, /state === 'manifested'\) return 'MANIFESTED'/);
  assert.match(alertSource, /state === 'vanished'\) return 'VANISHED'/);
  assert.match(alertSource, /INSPECT PRODUCT/);
  assert.match(alertSource, /BUY \/ VIEW PRODUCT/);
  assert.match(alertSource, /VIEW LAST PRODUCT PAGE/);
  assert.match(alertSource, /linksPrepared: true/);
});

test('rich alert queries scope lifecycle stage before LIMIT so one burst cannot starve the other tabs', () => {
  assert.match(alertSource, /\(\$2::text IS NULL OR s\.state=\$2\)/);
  assert.match(alertSource, /pool\.query\(ALERT_SQL, \[id \|\| null, safeState, safeLimit\]\)/);
  assert.match(signalSource, /PUBLIC_SIGNAL_STATES\.includes\(requestedState\)/);
  assert.match(signalSource, /listCanonicalPublicAlerts\(store, \{ id, state, limit \}\)/);
});
