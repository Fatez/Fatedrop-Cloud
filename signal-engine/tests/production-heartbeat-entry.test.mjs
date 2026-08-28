import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const productionServer = fs.readFileSync(path.join(here, "../src/server-production.mjs"), "utf8");

test("production server directly starts the lifecycle push heartbeat", () => {
  assert.match(productionServer, /import "\.\/notifications\/lifecycle-push-heartbeat\.mjs";/);
});
