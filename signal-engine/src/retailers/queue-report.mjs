import { buildQualificationQueue } from "./qualification-queue.mjs";
import { retailerDiscoverySeeds, retailerDiscoveryStats } from "./retailer-discovery-network.mjs";

const report = buildQualificationQueue(retailerDiscoverySeeds);
console.log(JSON.stringify({
  seedBatches: retailerDiscoveryStats,
  coverage: report.coverage,
  actionable: report.actionable,
  blocked: report.blocked,
  queue: report.queue.map((row) => ({
    retailerId: row.retailerId,
    name: row.name,
    countryCode: row.candidate.countryCode,
    shipsToUk: row.candidate.delivery.shipsToUk,
    retailerClass: row.retailerClass,
    adapterType: row.adapterType,
    state: row.state,
    operationalPriority: row.operationalPriority,
    blockers: row.blockers,
    tasks: row.tasks,
  })),
}, null, 2));
