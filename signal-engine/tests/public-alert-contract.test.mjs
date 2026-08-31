import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { listCanonicalPublicAlerts } from '../src/telemetry/public-alert-contract.mjs';

const alertSource = await readFile(new URL('../src/telemetry/public-alert-contract.mjs', import.meta.url), 'utf8');
const signalSource = await readFile(new URL('../src/telemetry/public-signal-contract.mjs', import.meta.url), 'utf8');
const visibilitySource = await readFile(new URL('../src/core/signal-visibility-policy.mjs', import.meta.url), 'utf8');

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

test('missing event TCG identity remains unknown and never defaults to Pokémon', async () => {
  const [alert] = await listCanonicalPublicAlerts(storeReturning(vanishedRow()), { state: 'vanished', limit: 1 });
  assert.equal(alert.tcgCode, 'unknown');
  assert.equal(alert.product.tcgCode, 'unknown');
  assert.equal(alert.notification.data.tcgCode, 'unknown');
  assert.match(signalSource, /tcgCode: alert\.tcgCode \|\| 'unknown'/);
  assert.match(signalSource, /tcgCode: signal\.tcgCode \|\| signal\.tcg \|\| 'unknown'/);
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

test('Cloud exposes one canonical episode while keeping Echo and Whisper outside stock truth', async () => {
  assert.match(alertSource, /fatedrop_stock_episode_events canonical_event/);
  assert.match(alertSource, /fatedrop_stock_episodes canonical_episode/);
  assert.match(alertSource, /history_event\.episode_id=canonical_event\.episode_id/);
  const row = vanishedRow({
    state: 'echo',
    stock_episode_id: 'ep_1',
    stock_episode_scope_type: 'online',
    stock_episode_cycle_number: 2,
    stock_episode_state: 'available',
    stock_episode_availability_state: 'available',
    stock_episode_opened_at: 100,
    stock_episode_manifested_at: 150,
    stock_episode_vanished_at: null,
    stock_episode_latest_event_at: 200,
    stock_episode_event_stage: 'echo',
    stock_episode_event_availability_effect: 'none',
  });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'echo', limit: 1 });
  assert.equal(alert.stockEpisode.id, 'ep_1');
  assert.equal(alert.stockEpisode.availabilityState, 'available');
  assert.deepEqual(alert.availabilityTruth, {
    signalEffect: 'none',
    signalClaimsAvailability: false,
    currentEpisodeState: 'available',
    canonicalSourceStage: null,
  });
});

test('history-only Manifested anchors remain lifecycle evidence but never occupy the public inbox window', () => {
  assert.match(alertSource, /publicSignalSqlFilter/);
  assert.match(alertSource, /AND \$\{publicSignalSqlFilter\('s'\)\}/);
  assert.match(visibilitySource, /policy_item->>'kind'='delivery_policy'/);
  assert.match(visibilitySource, /history_only/);
  assert.match(visibilitySource, /anomaly_quarantine/);
  assert.match(alertSource, /hs\.state='manifested'/);
  assert.match(alertSource, /ORDER BY hs\.detected_at DESC/);
});

test('Vanished stays fail-closed but accepts canonical persisted prior-live proof when baseline suppressed the Manifested alert row', () => {
  assert.match(alertSource, /validVanishedSqlFilter/);
  assert.match(alertSource, /AND \$\{validVanishedSqlFilter\('s'\)\}/);
  assert.match(visibilitySource, /prior_live_confirmation/);
  assert.match(visibilitySource, /persisted_purchasable_offer/);
  assert.match(alertSource, /evidence_item->>'kind'='prior_live_confirmation'/);
  assert.match(alertSource, /evidence_item->>'value'='persisted_purchasable_offer'/);
  assert.match(alertSource, /evidence_item->>'observedAt'/);
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

test('open Manifested episodes expose only fresh, healthy current-offer confirmation', async () => {
  assert.match(alertSource, /current_live\.last_confirmed_live_at AS current_live_confirmation_at/);
  assert.match(alertSource, /canonical_episode\.availability_state='available'/);
  assert.match(alertSource, /ro\.last_seen_at >= EXTRACT\(EPOCH FROM NOW\(\)\)::bigint - 1800/);
  const row = vanishedRow({
    state: 'manifested',
    detected_at: 100,
    stock_episode_id: 'ep_live_1',
    stock_episode_availability_state: 'available',
    stock_episode_manifested_at: 100,
    stock_episode_vanished_at: null,
    current_live_confirmation_at: 190,
  });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'manifested', limit: 1 });
  assert.deepEqual(alert.liveWindow, {
    manifestedAt: '1970-01-01T00:01:40.000Z',
    lastConfirmedLiveAt: '1970-01-01T00:03:10.000Z',
    vanishedAt: null,
    observedDurationSeconds: 90,
    historyComplete: true,
  });
  assert.deepEqual(alert.opportunity, {
    eventKind: 'availability_started',
    current: true,
    currentViewKind: 'still_available',
    firstManifestedAt: '1970-01-01T00:01:40.000Z',
    lastVerifiedAt: '1970-01-01T00:03:10.000Z',
  });
});

test('closed or unconfirmed Manifested episode cannot masquerade as outstanding stock', async () => {
  const row = vanishedRow({
    state: 'manifested',
    stock_episode_id: 'ep_closed_1',
    stock_episode_availability_state: 'unavailable',
    stock_episode_manifested_at: 100,
    stock_episode_vanished_at: 180,
    current_live_confirmation_at: 190,
  });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'manifested', limit: 1 });
  assert.equal(alert.liveWindow, null);
  assert.deepEqual(alert.opportunity, {
    eventKind: 'availability_started',
    current: false,
    currentViewKind: null,
    firstManifestedAt: null,
    lastVerifiedAt: null,
  });
});

test('event kinds explain activity without inventing another lifecycle engine', async () => {
  const [newRetailer] = await listCanonicalPublicAlerts(storeReturning(vanishedRow({
    state: 'manifested',
    stock_episode_id: 'ep_new_retailer',
    stock_episode_availability_state: 'available',
    stock_episode_manifested_at: 100,
    stock_episode_vanished_at: null,
    current_live_confirmation_at: 190,
    evidence: [{ kind: 'signal_kind', value: 'new_listing_live' }],
  })), { state: 'manifested', limit: 1 });
  assert.equal(newRetailer.opportunity.eventKind, 'new_retailer_available');
  assert.equal(newRetailer.opportunity.currentViewKind, 'still_available');
  assert.match(newRetailer.notification.body, /New verified retailer availability/);

  const [echo] = await listCanonicalPublicAlerts(storeReturning(vanishedRow({ state: 'echo' })), { state: 'echo', limit: 1 });
  assert.equal(echo.opportunity.eventKind, 'retailer_behaviour_changed');
  assert.equal(echo.opportunity.current, false);
});

test('current opportunity mode is enforced inside Cloud SQL and orders by fresh verification', async () => {
  let captured;
  const store = {
    async pool() {
      return {
        async query(sql, params) {
          captured = { sql, params };
          return { rows: [] };
        },
      };
    },
  };
  await listCanonicalPublicAlerts(store, { state: 'manifested', currentOnly: true, limit: 12 });
  assert.deepEqual(captured.params, [null, ['manifested'], 12, null, null, null, true]);
  assert.match(captured.sql, /\$7::boolean IS NOT TRUE OR/);
  assert.match(captured.sql, /canonical_episode\.availability_state='available'/);
  assert.match(captured.sql, /current_live\.last_confirmed_live_at IS NOT NULL/);
  assert.match(captured.sql, /CASE WHEN \$7::boolean IS TRUE THEN current_live\.last_confirmed_live_at END DESC/);
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

test('Cloud alert output carries one canonical policy, facet, presentation and delivery envelope', async () => {
  const row = vanishedRow({
    delivery_policy: 'inbox_only',
    evidence: [
      { kind: 'signal_kind', value: 'catalogue_new' },
      {
        kind: 'alert_facets',
        version: 2,
        languageGroup: 'japanese',
        languageCode: 'ja',
        marketCode: 'JP',
        marketGroup: 'japanese',
        marketStatus: 'verified',
        languageConfidence: 1,
        languageSource: 'explicit_language',
        marketConfidence: 1,
        marketSource: 'operator_verified',
        setKey: 'pokemon-151',
        setName: 'Pokémon 151',
        setConfidence: 1,
        setSource: 'title_alias:pokemon 151',
      },
      { kind: 'rrp_reference_basis', value: 'official_msrp' },
    ],
    discord_delivery_result: 'skipped',
    discord_delivery_detail: 'policy_inbox_only',
    discord_delivery_attempted_at: 195,
  });
  const [alert] = await listCanonicalPublicAlerts(storeReturning(row), { state: 'vanished', limit: 1 });
  assert.equal(alert.signalKind, 'catalogue_new');
  assert.equal(alert.deliveryPolicy, 'inbox_only');
  assert.equal(alert.interruptEligible, false);
  assert.equal(alert.facets.languageGroup, 'japanese');
  assert.equal(alert.facets.setKey, 'pokemon-151');
  assert.equal(alert.presentation.referenceBasis, 'official_msrp');
  assert.deepEqual(alert.delivery.discord, {
    status: 'skipped',
    attemptedAt: '1970-01-01T00:03:15.000Z',
    issue: 'policy_inbox_only',
    providerMessageId: null,
  });
});

test('rich alert queries scope lifecycle stage before LIMIT so one burst cannot starve the other tabs', () => {
  assert.match(alertSource, /\(\$2::text\[\] IS NULL OR s\.state=ANY\(\$2\)\)/);
  assert.match(alertSource, /pool\.query\(ALERT_SQL, \[id \|\| null, safeStates, safeLimit, safeSince, safeBefore/);
  assert.match(signalSource, /const requestedStates =/);
  assert.match(signalSource, /listCanonicalPublicAlerts\(store, \{ states: requestedStates, limit: safeLimit \}\)/);
});

test('alert recovery cursor is stable across same-second events and reaches the SQL boundary exactly', async () => {
  let captured;
  const store = {
    async pool() {
      return {
        async query(sql, params) {
          captured = { sql, params };
          return { rows: [] };
        },
      };
    },
  };
  await listCanonicalPublicAlerts(store, {
    state: 'manifested',
    since: 100,
    before: 200,
    beforeId: 'sig_cursor',
    limit: 25,
  });
  assert.deepEqual(captured.params, [null, ['manifested'], 25, 100, 200, 'sig_cursor', false]);
  assert.match(captured.sql, /s\.detected_at < \$5 OR \(s\.detected_at=\$5 AND s\.id>COALESCE\(\$6::text,''\)\)/);
  assert.match(captured.sql, /s\.detected_at DESC,s\.id ASC/);
});
