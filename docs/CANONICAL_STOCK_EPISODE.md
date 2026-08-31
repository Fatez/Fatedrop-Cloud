# Canonical Stock Episode and delivery ledger

## Truth model

One stock episode represents one retailer-offer availability cycle.

| Stage | Episode role | Availability effect |
| --- | --- | --- |
| Whisper | Product/listing evidence | None |
| Echo | Readiness or traffic evidence | None |
| Manifested | First verified purchasable state | Available |
| Vanished | Loss of previously verified availability | Unavailable; closes the episode |

Whisper and Echo can open or enrich an episode, including an already available
episode, but cannot change availability. Vanished is accepted only when the same
open episode has a prior Manifested event. Unsupported, incomplete, orphaned and
out-of-order events are written to `fatedrop_stock_episode_conflicts`; they are
not written to the public `fatedrop_signals` stream.
Database checks plus the episode-event trigger enforce the same stage/effect and
prior-Manifested rules even if a future writer bypasses the current store helper.

After Vanished closes a cycle, later Whisper, Echo or Manifested evidence starts
a new cycle. Earlier events remain immutable.

## FateDrop-owned exactly-once boundary

Signal persistence, episode mutation, episode-event append and outbox creation
share one PostgreSQL transaction. `idempotency_key` and the unique
`(signal_id, channel, destination_key)` constraint guarantee one FateDrop ledger
obligation per logical delivery.

Workers claim rows with `FOR UPDATE SKIP LOCKED` and a lease. Provider acceptance,
the attempt ledger and the outbox final state are then committed together.
Authoritative provider rejections can retry through the same obligation. If the
process loses the provider response or crashes after crossing the provider
boundary, the row becomes `outcome_unknown` and is not blindly retried. Discord
messages include the canonical signal ID in their footer for later reconciliation.

Discord and push providers are outside this exactly-once boundary and remain
at-least-once systems. FateDrop never treats their retry behaviour as canonical
truth. Public Discord uses `fatedrop_signal_delivery_outbox`; personalised push
continues to be owned by the existing per-user Web notification outbox. This
migration reserves the `push` channel without creating competing push rows.

Recovery consumes only explicit outbox rows. It never scans historical
`fatedrop_signals` to manufacture new obligations, so the migration does not
replay legacy Whisper orphans. Pending evidence alerts are suppressed when newer
canonical availability truth supersedes them. Evidence-only events do not
suppress a still-valid Manifested alert.

## Rollout order

1. Apply `signal-engine/database/canonical-stock-episodes.sql` after the existing
   product, offer, signal and delivery-telemetry schemas.
2. Verify the new tables, checks, unique indexes and pending-row index.
3. Deploy the Cloud code.
4. Verify new signals create one episode event and one Discord outbox disposition.
   Confirm the episode ID and event effect are exposed through the canonical
   public alert contract used by Web and App.
5. Verify no historical signal rows were backfilled into the outbox.
6. Monitor `outcome_unknown`, `dead_letter` and pending conflict counts before
   increasing delivery concurrency.

The migration is additive but the new Cloud write path requires it. Do not deploy
the code before the migration is verified.
