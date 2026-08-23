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

### Rate-safe self-healing

The supervisor is deliberately conservative because repeatedly walking a large catalogue can create retailer pressure and eventually lead to temporary access or IP restrictions.

In long-running supervised mode FateDrop therefore enforces these lower bounds even if an older local `.env` requests a faster setting:

- full catalogue rotation: **no faster than once every 5 minutes**;
- settle between catalogue page actions: **at least 4 seconds**;
- two rejected rotations in one collector session: **10-minute cooldown** before another collector attempt;
- queue / traffic-control evidence: **at least 5-minute cooldown**;
- security-verification evidence: **at least 15-minute cooldown**;
- explicit access-block evidence: **at least 60-minute cooldown**;
- repeated child-process crashes: exponential restart backoff from **1 minute up to 30 minutes**.

These values are defaults/minimums, not a promise about Pokémon Center's own thresholds. They are intentionally fail-closed: if access conditions deteriorate, FateDrop reduces requests and preserves the last verified catalogue rather than trying to push through the retailer control.

Longer values can be configured in `.env`. The supervisor will not accept values below the safe cycle/page-action floors for continuous operation.

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

`npm start` uses the supervisor. The supervisor watches Chrome's normal CDP endpoint, enforces the safe pacing/cooldown policy above, and launches the existing collector as a child process. If Chrome/CDP disappears it stops the child collector rather than letting a dead browser reference keep looping; when Chrome becomes available again it waits for any active cooldown and then reconnects normally.

For a one-off direct/debug run without the supervisor:

```bash
npm run start:direct
```

`start:direct` is for deliberate one-off debugging. Continuous monitoring should use `npm start` so the pacing, cooldown and restart safeguards remain active.

Optional supervisor settings are documented in `.env.example`, including the CDP probe interval/timeout, restart backoff and readiness cooldowns.

The collector verifies the captured unique product count against Pokémon Center's own `numFound` value before anything is sent to FateDrop Cloud. An incomplete scan is rejected and the last verified cloud catalogue remains intact.

The external ingest path uses the normal FateDrop lifecycle engine:

- **Whisper** — product/catalogue movement before confirmed purchasable availability.
- **Echo** — queue, traffic-control, security or access-readiness change. Echo is produced by the browser readiness path, not by an ordinary stock transition.
- **Manifested** — confirmed purchasable availability, including a verified restock.
- **Vanished** — previously purchasable availability is no longer verified.

Signals can then fan out through the normal FateDrop delivery paths such as Discord and website/app activity. A readiness observation never claims stock is imminent and never causes the collector to bypass retailer controls.
