import { ukRetailerDiscoveryFunnel, ukRetailerDiscoveryFunnelStats } from "./uk-discovery-funnel.mjs";

console.log(JSON.stringify({
  coverage: ukRetailerDiscoveryFunnelStats,
  note: "Discovery leads are not live retailers. A retailer only becomes monitored after website qualification, dry-run catalogue validation and explicit lifecycle promotion.",
  nextWebsiteQualification: ukRetailerDiscoveryFunnel
    .filter((row) => row.status === "lead")
    .slice(0, 30)
    .map((row) => ({ name: row.name, city: row.city, sourceName: row.sourceName, sourceUrl: row.sourceUrl })),
}, null, 2));
