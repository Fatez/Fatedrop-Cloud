import { buildQualificationQueue } from "./qualification-queue.mjs";
import { ukRetailerDiscoverySeeds, ukRetailerDiscoveryStats } from "./uk-discovery-network.mjs";

const report = buildQualificationQueue(ukRetailerDiscoverySeeds);
console.log(JSON.stringify({
  seedBatches: ukRetailerDiscoveryStats,
  coverage: report.coverage,
  actionable: report.actionable,
  blocked: report.blocked,
  queue: report.queue.map((row) => ({
    retailerId: row.retailerId,
    name: row.name,
    retailerClass: row.retailerClass,
    adapterType: row.adapterType,
    state: row.state,
    operationalPriority: row.operationalPriority,
    blockers: row.blockers,
    tasks: row.tasks,
  })),
}, null, 2));
