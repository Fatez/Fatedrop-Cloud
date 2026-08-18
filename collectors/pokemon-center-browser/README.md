# FateDrop Pokémon Center browser collector

This collector observes Pokémon Center UK's structured catalogue responses from a normal Chrome session and forwards verified product observations to the FateDrop Signal Engine.

It does not scrape rendered HTML and it does not bypass retailer access controls. If Pokémon Center presents a security/interstitial page or the catalogue API is not observed, the collector stops and asks for manual review.

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

The external ingest path then uses the normal FateDrop lifecycle engine, so stock transitions can produce Whisper, Manifested, Vanished and Echo signals and fan out to Discord and the website snapshot publisher.
