import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { createStore } from "./stores/index.mjs";

const store = createStore();
const [stats, products] = await Promise.all([
  store.stats(),
  typeof store.listProducts === "function" ? store.listProducts({ limit: 5000 }) : [],
]);
const officialRrpProducts = products.filter((product) => product.officialRrpPence != null && product.rrpSource);

console.log(`📚 FateDrop store: ${stats.productsTracked ?? products.length} products · ${officialRrpProducts.length} verified RRP references`);

if (!officialRrpProducts.length) {
  console.error("❌ No verified official RRP references are available in the current Signal Engine store. Run the official retailer collector first.");
  process.exitCode = 2;
} else {
  const website = await publishWebsiteSnapshot({ store, source: "FateDrop Official Reference Sync" });
  console.log(JSON.stringify({ officialRrpProducts: officialRrpProducts.length, website }, null, 2));
  if (!website.published) process.exitCode = 1;
}
