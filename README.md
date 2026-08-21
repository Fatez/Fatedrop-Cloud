# FateDrop Cloud

Cloud backend for FateDrop.

This repository is the 24/7 backend that will power FateSignal, live retailer data, True Price, Expo push notifications, premium Discord alerts, Indie retailer updates, and APIs consumed by the FateDrop app and website.

## Current foundation

Implemented on the `agent/fatedrop-cloud-foundation` branch:

- Express + TypeScript API shell
- Central FateDrop event bus
- FateSignal state/scoring foundation
- Signal episode history model for future false-alarm and likelihood calibration
- True Price calculations: RRP, item premium, delivery, mandatory fees, total delivered cost, and delivered premium
- Notification dispatcher
- Expo Push adapter
- User/device notification preference model
- Premium Discord routing adapter
- Indie retailer registration and live offer/stock update flow
- PostgreSQL schema for users, devices, retailers, products, offers, snapshots, events, signal episodes, notification deliveries, watchlists, and collector events
- Development event endpoint
- Unit tests for FateSignal, True Price, and notification routing

## Deliberately not implemented yet

The existing Pokémon Center monitoring/collector code from the original local FateDrop project has not been recreated here. It should be audited and migrated from the existing VS Code/Codex project so the proven collector is reused rather than duplicated.

## Local development

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm run dev
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

## Cloud deployment

The repository is intended to be deployed to an always-on Node-capable host with PostgreSQL. The host will install dependencies and run the service, so a local Node installation is not required merely to keep the production service online.
