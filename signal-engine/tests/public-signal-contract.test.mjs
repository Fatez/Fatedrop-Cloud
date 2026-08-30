import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicContract = readFileSync(resolve(here, '../src/telemetry/public-signal-contract.mjs'), 'utf8');
const signalHealth = readFileSync(resolve(here, '../src/telemetry/signal-health-summary.mjs'), 'utf8');
const fateDropServer = readFileSync(resolve(here, '../src/http/fatedrop-server.mjs'), 'utf8');
const topServer = readFileSync(resolve(here, '../src/server.mjs'), 'utf8');

test('public signal feed is Cloud-owned, versioned, no-store and canonical for Vanished', () => {
  assert.match(publicContract, /PUBLIC_SIGNAL_CONTRACT_VERSION = 1/);
  assert.match(publicContract, /contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION/);
  assert.match(publicContract, /source: 'FATEDROP_CLOUD'/);
  assert.match(publicContract, /'cache-control': 'no-store'/);
  assert.match(publicContract, /s\.state <> 'vanished'/);
  assert.match(publicContract, /m\.state='manifested'/);
  assert.match(publicContract, /v\.state='vanished'/);
  assert.match(publicContract, /canonicalSignalVisible/);
});

test('public signal summary exposes only safe dashboard aggregates', () => {
  assert.match(publicContract, /lifecycle: summary\.lifecycle/);
  assert.match(publicContract, /delivery: safeDelivery\(summary\.delivery\)/);
  assert.match(publicContract, /diagnostics: safeDiagnostics\(summary\.diagnostics\)/);
  assert.match(publicContract, /orphanedDiscordSignals: safeCount\(reliability\.orphanedDiscordSignals\)/);
  assert.match(publicContract, /totalRetailers: safeCount\(monitors\.totalRetailers\)/);
  assert.match(publicContract, /sampleSize: safeCount\(discordLatency\.sampleSize\)/);
  assert.match(publicContract, /pending: safeCount\(discovery\.pending\)/);
  assert.doesNotMatch(publicContract, /diagnostics: summary\.diagnostics/);
  assert.doesNotMatch(publicContract, /monitorRows/);

  for (const privateField of [
    'orphanedSignalIds',
    'staleRetailerIds',
    'unhealthyRetailerIds',
    'blockedRetailerIds',
    'event_id',
    'raw_data',
    'sourceUrl',
    'DATABASE_URL',
  ]) {
    assert.doesNotMatch(publicContract, new RegExp(privateField));
  }
});

test('private signal health aggregation applies the same valid-Vanished rule everywhere', () => {
  assert.match(signalHealth, /const VALID_VANISHED_FILTER/);
  assert.match(signalHealth, /s\.state <> 'vanished'/);
  assert.match(signalHealth, /m\.state='manifested'/);
  assert.match(signalHealth, /v\.state='vanished'/);
  const filterUses = signalHealth.match(/\$\{VALID_VANISHED_FILTER\}/g) || [];
  assert.ok(filterUses.length >= 3, 'detection, delivery and latency queries must all apply the canonical valid-Vanished filter');
});

test('FateDrop HTTP server routes live signal reads through the canonical public contract', () => {
  assert.match(fateDropServer, /handlePublicSignals/);
  assert.match(fateDropServer, /url\.pathname==="\/api\/signals"/);
  assert.match(fateDropServer, /handlePublicSignalSummary/);
  assert.match(fateDropServer, /url\.pathname==="\/api\/signal-summary"/);
});

test('public product signal contracts stay separate from private operational diagnostics', () => {
  assert.match(topServer, /"\/api\/signal-health"/);
  assert.doesNotMatch(topServer, /"\/api\/signal-summary"/);
  assert.match(fateDropServer, /"\/api\/signal-summary"/);
});
