import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const alertSource = await readFile(new URL('../src/telemetry/public-alert-contract.mjs', import.meta.url), 'utf8');
const signalSource = await readFile(new URL('../src/telemetry/public-signal-contract.mjs', import.meta.url), 'utf8');

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
