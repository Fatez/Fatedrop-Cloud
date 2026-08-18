import process from "node:process";
import { chromium } from "playwright-core";
import { mapPokemonCenterDoc } from "./map.mjs";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const API_PATH = "/tpci-ecommweb-api/search";
const NEXT_BUTTON = 'button[aria-label="Go to next page"]';
const RETAILER_ID = "pokemon-center-uk";

const chromeCdpUrl = process.env.FATEDROP_CHROME_CDP_URL || "http://127.0.0.1:9222";
const catalogueUrl = process.env.FATEDROP_POKEMON_CATALOGUE_URL || "https://www.pokemoncenter.com/en-gb/search/tcg-cards";
const ingestUrl = process.env.FATEDROP_SIGNAL_INGEST_URL || "";
const ingestSecret = process.env.FATEDROP_SIGNAL_INGEST_SECRET || "";
const responseTimeoutMs = Math.max(5_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_RESPONSE_TIMEOUT_MS || "30000", 10));
const settleMs = Math.max(0, Number.parseInt(process.env.FATEDROP_COLLECTOR_SETTLE_MS || "1500", 10));

function requireConfig() {
  if (!ingestUrl) throw new Error("FATEDROP_SIGNAL_INGEST_URL is required");
  if (!ingestSecret) throw new Error("FATEDROP_SIGNAL_INGEST_SECRET is required");
}

function matchesCatalogueApi(response) {
  return response.url().includes(API_PATH);
}

async function parseBatch(response) {
  const data = await response.json();
  const api = data?.response;
  if (!api || !Array.isArray(api.docs)) throw new Error("Pokémon Center catalogue response contained no response.docs array");
  return {
    start: Number.isFinite(api.start) ? api.start : 0,
    total: Number.isFinite(api.numFound) ? api.numFound : null,
    docs: api.docs,
    responseUrl: response.url(),
  };
}

async function nextButton(page) {
  const next = page.locator(NEXT_BUTTON).first();
  try {
    await next.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return null;
  }
  const disabled = await next.isDisabled().catch(() => false);
  const ariaDisabled = await next.getAttribute("aria-disabled");
  return disabled || ariaDisabled === "true" ? null : next;
}

async function captureFirstPage(page) {
  const responsePromise = page.waitForResponse(matchesCatalogueApi, { timeout: responseTimeoutMs });
  await page.goto(catalogueUrl, { waitUntil: "domcontentloaded", timeout: responseTimeoutMs });
  try {
    return await parseBatch(await responsePromise);
  } catch (error) {
    throw new Error(`No usable Pokémon Center catalogue API response was observed. Check the browser tab manually; FateDrop will not bypass access controls. ${error.message}`);
  }
}

async function captureFollowingPage(page, pageNumber) {
  const next = await nextButton(page);
  if (!next) return null;

  const responsePromise = page.waitForResponse(matchesCatalogueApi, { timeout: responseTimeoutMs });
  console.log(`➡️  Pokémon catalogue page ${pageNumber}`);
  await next.click();
  const batch = await parseBatch(await responsePromise);
  if (settleMs) await page.waitForTimeout(settleMs);
  return batch;
}

async function collectCatalogue(page) {
  const productsBySku = new Map();
  const starts = new Set();
  let expectedTotal = null;
  let pageNumber = 1;

  function storeBatch(batch) {
    if (starts.has(batch.start)) throw new Error(`Repeated Pokémon catalogue offset ${batch.start}; refusing incomplete/repeated scan`);
    starts.add(batch.start);
    if (expectedTotal == null && Number.isFinite(batch.total)) expectedTotal = batch.total;

    for (const raw of batch.docs) {
      const mapped = mapPokemonCenterDoc(raw);
      if (!mapped) continue;
      productsBySku.set(mapped.retailerSku, mapped);
    }

    console.log(`📦 page ${pageNumber}: ${batch.docs.length} docs · ${productsBySku.size}${expectedTotal ? `/${expectedTotal}` : ""} unique products`);
  }

  console.log("📡 Capturing Pokémon Center structured catalogue feed...");
  const first = await captureFirstPage(page);
  storeBatch(first);

  while (true) {
    pageNumber += 1;
    const batch = await captureFollowingPage(page, pageNumber);
    if (!batch) break;
    storeBatch(batch);
    if (expectedTotal != null && productsBySku.size >= expectedTotal) break;
  }

  const products = [...productsBySku.values()];
  if (expectedTotal != null && products.length !== expectedTotal) {
    throw new Error(`Incomplete Pokémon catalogue scan: captured ${products.length}/${expectedTotal}; nothing will be ingested`);
  }
  if (!products.length) throw new Error("Pokémon catalogue scan returned zero usable products");

  console.log(`✅ Full Pokémon catalogue verified: ${products.length} products`);
  return products;
}

async function ingest(products) {
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fatedrop-secret": ingestSecret,
    },
    body: JSON.stringify({ retailerId: RETAILER_ID, products }),
  });
  const body = await response.text();
  let parsed;
  try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body }; }
  if (!response.ok) throw new Error(`Signal Engine ingest failed (${response.status}): ${body.slice(0, 500)}`);
  return parsed;
}

async function run() {
  requireConfig();
  console.log("🔥 FateDrop Pokémon Center browser collector");
  console.log(`🔌 Connecting to Chrome at ${chromeCdpUrl}`);

  const browser = await chromium.connectOverCDP(chromeCdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("No Chrome context found. Start Chrome with remote debugging enabled first.");

    let page = context.pages().find((candidate) => candidate.url().includes("pokemoncenter.com"));
    if (!page) page = await context.newPage();
    await page.bringToFront();

    const products = await collectCatalogue(page);
    console.log(`☁️  Sending ${products.length} products to FateDrop Signal Engine...`);
    const result = await ingest(products);

    const signalResult = result?.result || {};
    const website = result?.website || {};
    console.log(`✅ Ingest complete · signals=${signalResult.signalsCreated ?? "?"} · Discord sent=${signalResult.discord?.sent ?? "?"} · website=${website.published ? "published" : website.reason || "?"}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(`❌ FateDrop collector failed: ${error?.message || error}`);
  process.exitCode = 1;
});
