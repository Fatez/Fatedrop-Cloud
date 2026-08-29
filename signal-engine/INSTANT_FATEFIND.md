# Instant FateFind evaluation

A newly saved hosted FateFind can be evaluated immediately through the private `POST /internal/fatefind/evaluate` endpoint.

The endpoint accepts only a `fateFindId`, requires the existing `FATEDROP_SIGNAL_API_TOKEN` bearer token, reuses the canonical PostgreSQL store and hosted FateFind evaluator, and does not trigger a retailer scan or alter the scheduled scan cadence.

The scheduled hosted FateFind cycle remains the fallback for later retailer observations and recovery.
