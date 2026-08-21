import process from "node:process";
import { retailers as staticRetailers } from "../config/retailers.mjs";
import { dryRunStaticRetailer } from "./static-dry-run.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const retailerId = arg("retailer");
if (!retailerId) {
  console.error("Usage: npm run retailers:static-dry-run -- --retailer=<configured-retailer-id>");
  process.exit(1);
}

const retailer = staticRetailers.find((row) => row.id === retailerId);
if (!retailer) {
  console.error(JSON.stringify({
    mode: "static-dry-run-only",
    persisted: false,
    retailerId,
    error: `Unknown configured retailer: ${retailerId}`,
  }, null, 2));
  process.exit(1);
}

try {
  const result = await dryRunStaticRetailer(retailer);
  console.log(JSON.stringify({ mode: "static-dry-run-only", ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    mode: "static-dry-run-only",
    persisted: false,
    published: false,
    retailerId,
    error: String(error?.message || error),
  }, null, 2));
  process.exit(2);
}
