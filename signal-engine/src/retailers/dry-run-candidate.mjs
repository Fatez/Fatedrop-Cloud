import process from "node:process";
import { dryRunRetailer } from "./dry-run.mjs";
import { prepareCandidateDryRun } from "./dry-run-probe.mjs";
import { ukRetailerDiscoverySeeds } from "./uk-discovery-network.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const retailerId = arg("retailer");
const allowStructuredFeedProbe = process.argv.includes("--probe-structured-feed");
if (!retailerId) {
  console.error("Usage: npm run retailers:dry-run -- --retailer=<seed-id> [--probe-structured-feed]");
  process.exit(1);
}

const candidate = ukRetailerDiscoverySeeds.find((row) => row.id === retailerId);
if (!candidate) {
  console.error(`Unknown retailer discovery seed: ${retailerId}`);
  process.exit(1);
}

try {
  const prepared = prepareCandidateDryRun(candidate, { allowStructuredFeedProbe });
  const result = await dryRunRetailer(prepared);
  console.log(JSON.stringify({
    mode: "dry-run-only",
    persisted: false,
    feedApprovalPersisted: false,
    retailerId,
    diagnostics: result.diagnostics,
    note: result.note,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    mode: "dry-run-only",
    persisted: false,
    retailerId,
    error: String(error?.message || error),
  }, null, 2));
  process.exit(2);
}
