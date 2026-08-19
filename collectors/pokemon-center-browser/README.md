# FateDrop Pokémon Center browser collector

This collector observes Pokémon Center UK's structured catalogue responses from a normal Chrome session and forwards verified product observations to the hosted FateDrop Signal Engine.

It does not scrape rendered HTML and it does not bypass retailer access controls. If Pokémon Center presents a security/interstitial page, queue, access block, or the catalogue API is not observed, the current rotation is rejected and the last verified cloud catalogue remains untouched.

## How the continuous rotation works

The collector stays attached to the user's normal Chrome session and runs repeated full catalogue walks:

1. Navigate back to the canonical Pokémon Center catalogue URL (page 1).
2. Capture page 1's structured catalogue response.
3. Click Next and capture every following page.
4. Verify the unique product count against Pokémon Center's own `numFound` total.
5. Only after a complete verified walk, send the catalogue to FateDrop Cloud.
6. Start the next rotation from page 1 again.

`FATEDROP_COLLECTOR_CYCLE_MS` is a minimum start-to-start interval and defaults to 60 seconds. If a full walk takes longer than the configured interval, the next rotation starts from page 1 immediately after the previous walk completes. This avoids overlapping walks while keeping detection latency low.

The collector also classifies visible browser-state changes such as a queue, security verification, or access block. A state transition is logged once rather than repeated every rotation. It never attempts to solve, defeat, or bypass those controls.

## Requirements

- Node.js 20+
- Chrome started with remote debugging enabled on port 9222
- A working Pokémon Center UK browser session
- `FATEDROP_SIGNAL_INGEST_URL`
- `FATEDROP_SIGNAL_INGEST_SECRET`

## Setup

```bash
npm install
cp .env.example .env
```

Fill in the Signal Engine ingest secret in `.env`. The example ingest URL already targets the hosted FateDrop Cloud service.

Start Chrome with a dedicated FateDrop profile and remote debugging enabled, then leave a Pokémon Center tab available. Example on Windows:

```text
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\FateDropChrome"
```

Use the browser normally if Pokémon Center asks you to complete a security check. The collector only resumes successful ingestion once the normal catalogue response becomes available again.

Then run:

```bash
npm start
```

The external ingest path uses the normal FateDrop lifecycle engine, so verified stock transitions can produce Whisper, Manifested, Vanished and Echo signals and fan out through the existing Signal Engine publishing path.
