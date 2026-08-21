# FateDrop Pokémon Center browser collector

This collector observes Pokémon Center UK's structured catalogue responses from a normal Chrome session and forwards verified product observations to the FateDrop Signal Engine.

It does not scrape rendered HTML and it does not bypass retailer access controls. If Pokémon Center presents a queue, security/interstitial page or access block, the collector records that readiness state for FateDrop and does not attempt to defeat or bypass the retailer control.

## Requirements

- Node.js 20+
- Chrome started with remote debugging enabled on port 9222
- A working Pokémon Center UK browser session
- `FATEDROP_SIGNAL_INGEST_URL`
- `FATEDROP_SIGNAL_INGEST_SECRET`

`FATEDROP_NETWORK_STATE_URL` may be set explicitly. When it is omitted, the collector derives `/internal/network-state` from `FATEDROP_SIGNAL_INGEST_URL`.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in the Signal Engine ingest URL and secret in `.env`.

Start Chrome with a dedicated FateDrop profile and remote debugging enabled, then leave a Pokémon Center tab available. Example on Windows:

```text
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\FateDropChrome"
```

For a manual/debug session, run the collector directly:

```bash
npm start
```

For the long-running host, prefer the supervised launcher:

```bash
npm run start:supervised
```

The supervisor only watches Chrome's normal CDP endpoint. It does not change the retailer-observation logic. If Chrome/CDP disappears it stops the child collector rather than letting a dead browser reference keep looping; when Chrome becomes available again it launches a fresh collector process and reconnects normally. Keep the supervisor itself under the host's normal process/session supervision if 24/7 operation is required.

Optional supervisor settings:

- `FATEDROP_COLLECTOR_SUPERVISOR_INTERVAL_MS` — CDP probe interval, minimum 5 seconds, default 10 seconds.
- `FATEDROP_COLLECTOR_SUPERVISOR_TIMEOUT_MS` — individual CDP probe timeout, bounded to 1–10 seconds, default 3 seconds.

The collector verifies the captured unique product count against Pokémon Center's own `numFound` value before anything is sent to FateDrop Cloud. An incomplete scan is rejected.

The external ingest path uses the normal FateDrop lifecycle engine:

- **Whisper** — product/catalogue movement before confirmed purchasable availability.
- **Echo** — queue, traffic-control, security or access-readiness change. Echo is produced by the browser readiness path, not by an ordinary stock transition.
- **Manifested** — confirmed purchasable availability, including a verified restock.
- **Vanished** — previously purchasable availability is no longer verified.

Signals can then fan out through the normal FateDrop delivery paths such as Discord and website/app activity. A readiness observation never claims stock is imminent and never causes the collector to bypass retailer controls.
