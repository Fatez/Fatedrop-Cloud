import process from "node:process";
import { inspectRetailerWebsite } from "./qualification-inspector.mjs";
import { retailerDiscoverySeeds } from "./retailer-discovery-network.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const retailerId = arg("retailer");
const url = arg("url");
const name = arg("name");
let candidate = retailerId ? retailerDiscoverySeeds.find((row) => row.id === retailerId) : null;
if (!candidate && url) candidate = { name: name || new URL(url).hostname, websiteUrl: url };
if (!candidate) {
  console.error("Usage: npm run retailers:inspect -- --retailer=<seed-id> OR --url=https://shop.example [--name=Shop]");
  process.exit(1);
}

const report = await inspectRetailerWebsite(candidate);
console.log(JSON.stringify(report, null, 2));
