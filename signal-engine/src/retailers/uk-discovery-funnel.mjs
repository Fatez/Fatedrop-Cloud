import { ukRetailerDirectoryLeads } from "./uk-discovery-leads.mjs";
import { ukRetailerDiscoverySeeds } from "./uk-discovery-network.mjs";

function leadKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(?:ltd|limited)\b/g, "")
    .replace(/\buk\b$/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

const byKey = new Map();
for (const lead of ukRetailerDirectoryLeads) {
  const key = leadKey(lead.name);
  if (!key || byKey.has(key)) continue;
  byKey.set(key, { ...lead, key });
}
for (const candidate of ukRetailerDiscoverySeeds) {
  const key = leadKey(candidate.name);
  if (!key) continue;
  byKey.set(key, {
    key,
    name: candidate.name,
    city: null,
    tcgs: candidate.tcgs,
    sourceType: candidate.discovery.source,
    sourceName: "FateDrop researched candidate",
    sourceUrl: candidate.websiteUrl,
    websiteUrl: candidate.websiteUrl,
    status: "candidate",
    retailerId: candidate.id,
    adapterType: candidate.adapterType,
    verification: candidate.verification,
    lifecycleState: candidate.state,
  });
}

export const ukRetailerDiscoveryFunnel = Object.freeze([...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)));

export const ukRetailerDiscoveryFunnelStats = Object.freeze({
  discoveredUnique: ukRetailerDiscoveryFunnel.length,
  websiteQualifiedCandidates: ukRetailerDiscoveryFunnel.filter((row) => row.status === "candidate").length,
  rawLeadsAwaitingWebsiteQualification: ukRetailerDiscoveryFunnel.filter((row) => row.status === "lead").length,
  verifiedCandidates: ukRetailerDiscoveryFunnel.filter((row) => row.status === "candidate" && row.verification === "verified").length,
  monitoredCandidates: ukRetailerDiscoveryFunnel.filter((row) => row.status === "candidate" && row.lifecycleState === "monitored").length,
});
