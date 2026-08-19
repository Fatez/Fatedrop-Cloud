import { candidateCoverage, deduplicateRetailerCandidates } from "./discovery.mjs";
import { onboardingPlan } from "./onboarding.mjs";
import { RETAILER_CLASSES } from "./registry.mjs";

const classWeight = Object.freeze({
  [RETAILER_CLASSES.NATIONAL]: 40,
  [RETAILER_CLASSES.SPECIALIST]: 30,
  [RETAILER_CLASSES.REGIONAL]: 20,
  [RETAILER_CLASSES.INDEPENDENT]: 10,
  [RETAILER_CLASSES.EVENT_VENDOR]: 5,
});

function operationalPriority(candidate, plan) {
  let score = classWeight[candidate.retailerClass] || 0;
  if (candidate.catalogue.urls.length || candidate.catalogue.feedUrl) score += 25;
  if (candidate.catalogue.platformEvidence.length) score += 10;
  if (candidate.delivery.known) score += 10;
  score += Math.min(10, candidate.discovery.evidence.length * 2);
  if (!plan.blockers.length) score += 5;
  return score;
}

// This queue is an internal onboarding-work priority. It is never exposed as a
// consumer retailer ranking and does not represent trust, quality or value.
export function buildQualificationQueue(inputs = []) {
  const candidates = deduplicateRetailerCandidates(inputs);
  const queue = candidates.map((candidate) => {
    const plan = onboardingPlan(candidate);
    return {
      retailerId: candidate.id,
      name: candidate.name,
      retailerClass: candidate.retailerClass,
      adapterType: candidate.adapterType,
      state: plan.state,
      readyForMonitoring: plan.readyForMonitoring,
      blockers: plan.blockers,
      tasks: plan.tasks,
      operationalPriority: operationalPriority(candidate, plan),
      candidate,
    };
  }).sort((a, b) => b.operationalPriority - a.operationalPriority || a.name.localeCompare(b.name));
  return {
    queue,
    coverage: candidateCoverage(candidates),
    actionable: queue.filter((row) => row.blockers.length === 0).length,
    blocked: queue.filter((row) => row.blockers.length > 0).length,
  };
}
