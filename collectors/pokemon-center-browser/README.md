# FateDrop Pokémon Center browser collector

This collector observes Pokémon Center UK's structured catalogue responses from a normal Chrome session and forwards verified product observations to the FateDrop Signal Engine.

It does not scrape rendered HTML and it does not bypass retailer access controls. If Pokémon Center presents a queue, security/interstitial page or access block, the collector records that readiness state for FateDrop and does not attempt to defeat or bypass the retailer control.

## Requirements

- Node.js 20+
- Google Chrome
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

### Recommended Windows host setup

From `collectors/pokemon-center-browser`, start the dedicated FateDrop Chrome profile and collector supervisor with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

The launcher checks the local Chrome CDP endpoint first. If the dedicated FateDrop Chrome session is not already running, it starts normal Google Chrome on port `9222` with a dedicated profile under `%LOCALAPPDATA%\FateDrop\PokemonCenterChrome`, opens the Pokémon Center UK TCG catalogue, waits for the real browser endpoint, and then starts the existing collector supervisor.

On the first run, complete any normal Pokémon Center session/cookie prompts in that dedicated Chrome window. FateDrop does not automate or bypass queue, security, access-control or retailer challenge pages.

Once the dedicated profile works normally, install the signed-in-user startup task with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-startup.ps1 -StartNow
```

The scheduled task:

- starts at Windows user logon;
- runs with normal user privileges, not elevated administrator privileges;
- restarts the launcher if it exits unexpectedly;
- prevents duplicate launcher instances;
- keeps ingest credentials in the local `.env` rather than embedding them in Task Scheduler.

The browser collector still requires a real interactive Windows session. If the host PC is powered off or the user is fully logged out, Pokémon Center monitoring is unavailable until that host session returns. FateDrop reports the source stale rather than pretending the browser collector is live.

To remove the automatic startup task later:

```powershell
Unregister-ScheduledTask -TaskName "FateDrop Pokemon Center Collector" -Confirm:$false
```

### Manual Chrome setup

If you prefer to manage Chrome yourself, start Chrome with a dedicated FateDrop profile and remote debugging enabled, then leave a Pokémon Center tab available. Example on Windows:

```text
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\FateDropChrome"
```

Then run the normal long-running collector command:

```bash
npm start
```

`npm start` uses the supervisor. The supervisor only watches Chrome's normal CDP endpoint. It does not change the retailer-observation logic. If Chrome/CDP disappears it stops the child collector rather than letting a dead browser reference keep looping; when Chrome becomes available again it launches a fresh collector process and reconnects normally.

For a one-off direct/debug run without the supervisor:

```bash
npm run start:direct
```

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
