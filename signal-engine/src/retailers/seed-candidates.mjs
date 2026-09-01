import { env } from "../config/env.mjs";
import { deduplicateRetailerCandidates } from "./discovery.mjs";
import { PostgresRetailerRegistry } from "./postgres-registry.mjs";
import { ukRetailerDiscoverySeeds } from "./uk-discovery-seeds.mjs";
import { ukRetailerNetwork100Seeds20260901 } from "./uk-retailer-network-100-2026-09-01.mjs";

if (!env.databaseUrl) throw new Error("DATABASE_URL is required to seed retailer candidates");

const registry = new PostgresRetailerRegistry(env.databaseUrl);
const candidates = deduplicateRetailerCandidates([
  ...ukRetailerDiscoverySeeds,
  ...ukRetailerNetwork100Seeds20260901,
]);
const results = [];
for (const candidate of candidates) {
  const saved = await registry.upsert(candidate);
  results.push({ id: saved.id, name: saved.name, state: saved.state, verification: saved.verification, adapterType: saved.adapterType });
}

console.log(JSON.stringify({ seeded: results.length, retailers: results }, null, 2));
