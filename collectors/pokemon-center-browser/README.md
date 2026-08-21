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

Then run:

```bash
npm start
```

The collector verifies the captured unique product count against Pokémon Center's own `numFound` value before anything is sent to FateDrop Cloud. An incomplete scan is rejected.

The external ingest path uses the normal FateDrop lifecycle engine:

- **Whisper** — product/catalogue movement before confirmed purchasable availability.
- **Echo** — queue, traffic-control, security or access-readiness change. Echo is produced by the browser readiness path, not by an ordinary stock transition.
- **Manifested** — confirmed purchasable availability, including a verified restock.
- **Vanished** — previously purchasable availability is no longer verified.

Signals can then fan out through the normal FateDrop delivery paths such as Discord and website/app activity. A readiness observation never claims stock is imminent and never causes the collector to bypass retailer controls.
