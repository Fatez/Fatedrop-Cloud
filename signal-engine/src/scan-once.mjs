import { retailers } from "./config/retailers.mjs";
import { scanAll } from "./core/engine.mjs";
import { createStore } from "./stores/index.mjs";

const requested = process.argv.find((x) => x.startsWith("--retailer="))?.split("=")[1];
const selected = requested ? retailers.filter((r) => r.id === requested) : retailers;
if (!selected.length) { console.error(`No enabled retailer matched ${requested || "configuration"}.`); process.exit(1); }
const results = await scanAll({ retailers: selected, store: createStore() });
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.error) ? 2 : 0);
