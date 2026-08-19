import process from "node:process";
import { chromium } from "playwright-core";
import { mapPokemonCenterDoc } from "./map.mjs";
import { BrowserState, browserStateLabel, classifyBrowserState, remainingCycleDelay } from "./runtime.mjs";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const NEXT_BUTTON = 'button[aria-label="Go to next page"]';
const RETAILER_ID = "pokemon-center-uk";

const chromeCdpUrl = process.env.FATEDROP_CHROME_CDP_URL || "http://127.0.0.1:9222";
const catalogueUrl = process.env.FATEDROP_POKEMON_CATALOGUE_URL || "https://www.pokemoncenter.com/en-gb/search/tcg-cards";
const ingestUrl = process.env.FATEDROP_SIGNAL_INGEST_URL || "";
const ingestSecret = process.env.FATEDROP_SIGNAL_INGEST_SECRET || "";
const responseTimeoutMs = Math.max(5_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_RESPONSE_TIMEOUT_MS || "30000", 10));
const settleMs = Math.max(0, Number.parseInt(process.env.FATEDROP_COLLECTOR_SETTLE_MS || "1500", 10));
const minimumCycleMs = Math.max(10_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_CYCLE_MS || "60000", 10));

let stopping = false;
let lastBrowserState = null;

function requireConfig() {
  if (!ingestUrl) throw new Error("FATEDROP_SIGNAL_INGEST_URL is required");
  if (!ingestSecret) throw new Error("FATEDROP_SIGNAL_INGEST_SECRET is required");
}

function extractCataloguePayload(data) {
  const candidates = [data?.response, data?.data?.response, data?.data, data];
  for (const api of candidates) {
    if (api && Array.isArray(api.docs)) return api;
  }
  return null;
}

async function parseBatch(response) {
  const data = await response.json();
  const api = extractCataloguePayload(data);
  if (!api) throw new Error("response did not contain a catalogue docs array");
  return {
    start: Number.isFinite(api.start) ? api.start : 0,
    total: Number.isFinite(api.numFound) ? api.numFound : null,
    docs: api.docs,
    responseUrl: response.url(),
  };
}

function responsePath(response) {
  try {
    return new URL(response.url()).pathname;
  } catch {
    return response.url();
  }
}

async function waitForCatalogueBatch(page, action) {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      page.off("response", onResponse);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onResponse = async (response) => {
      if (settled) return;
      const resourceType = response.request().resourceType();
      if (resourceType !== "xhr" && resourceType !== "fetch") return;

      try {
        const batch = await parseBatch(response);
        if (!batch.docs.length && batch.total !== 0) return;
        console.log(`🔎 Catalogue feed detected: ${responsePath(response)}`);
        finish(resolve, batch);
      } catch {
        // Most XHR/fetch responses are unrelated JSON or non-JSON. Ignore them.
      }
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out after ${responseTimeoutMs}ms waiting for a structured catalogue response`));
    }, responseTimeoutMs);

    page.on("response", onResponse);

    Promise.resolve()
      .then(action)
      .catch((error) => finish(reject, error));
  });
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

async function inspectBrowserState(page) {
  const snapshot = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    text: await page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
  };
  return classifyBrowserState(snapshot);
}

async function noteBrowserState(page, forcedState = null) {
  const state = forcedState || await inspectBrowserState(page);
  if (state !== lastBrowserState) {
    const previous = lastBrowserState;
    lastBrowserState = state;
    if (previous == null) {
      console.log(`🛰️  Browser state: ${browserStateLabel(state)}`);
    } else {
      console.log(`🚨 Browser state changed: ${browserStateLabel(previous)} → ${browserStateLabel(state)}`);
      if (state !== BrowserState.NORMAL) {
        console.log("⚠️  One-time local network-state change detected. FateDrop will not attempt to defeat or bypass the retailer control.");
      }
    }
  }
  return state;
}

async function captureFirstPage(page) {
  console.log("↩️  Returning to Pokémon catalogue page 1...");
  try {
    const batch = await waitForCatalogueBatch(page, () =>
      page.goto(catalogueUrl, { waitUntil: "domcontentloaded", timeout: responseTimeoutMs })
    );
    await noteBrowserState(page, BrowserState.NORMAL);
    return batch;
  } catch (error) {
    const state = await noteBrowserState(page);
    throw new Error(`No usable Pokémon Center catalogue API response was observed (${browserStateLabel(state)}). Check the browser tab manually; FateDrop will not bypass access controls. ${error.message}`);
  }
}

async function captureFollowingPage(page, pageNumber) {
  const next = await nextButton(page);
  if (!next) return null;

  console.log(`➡️  Pokémon catalogue page ${pageNumber}`);
  const batch = await waitForCatalogueBatch(page, () => next.click());
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle(page, cycleNumber) {
  const startedAtMs = Date.now();
  console.log(`\n🔄 FateDrop Pokémon Center rotation ${cycleNumber} started ${new Date(startedAtMs).toISOString()}`);

  try {
    await page.bringToFront();
    const products = await collectCatalogue(page);
    console.log(`☁️  Sending ${products.length} verified products to FateDrop Signal Engine...`);
    const result = await ingest(products);
    const signalResult = result?.result || {};
    const website = result?.website || {};
    console.log(`✅ Rotation ${cycleNumber} ingested · signals=${signalResult.signalsCreated ?? "?"} · Discord sent=${signalResult.discord?.sent ?? "?"} · website=${website.published ? "published" : website.reason || "?"}`);
  } catch (error) {
    console.error(`❌ Rotation ${cycleNumber} rejected: ${error?.message || error}`);
    console.error("🛡️  Last verified cloud catalogue remains untouched by this failed rotation.");
  }

  const waitMs = remainingCycleDelay({ startedAtMs, minimumCycleMs });
  if (waitMs > 0 && !stopping) {
    console.log(`⏱️  Next page-1 rotation in ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  } else if (!stopping) {
    console.log("⚡ Full walk exceeded the minimum cycle time; restarting at page 1 immediately.");
  }
}

async function run() {
  requireConfig();
  console.log("🔥 FateDrop Pokémon Center continuous browser collector");
  console.log(`🔌 Connecting to Chrome at ${chromeCdpUrl}`);
  console.log(`⏱️  Minimum rotation interval: ${Math.round(minimumCycleMs / 1000)}s`);

  const browser = await chromium.connectOverCDP(chromeCdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context found. Start Chrome with remote debugging enabled first.");

  let page = context.pages().find((candidate) => candidate.url().includes("pokemoncenter.com"));
  if (!page) page = await context.newPage();

  let cycleNumber = 0;
  while (!stopping) {
    cycleNumber += 1;
    await runCycle(page, cycleNumber);
  }

  console.log("👋 FateDrop collector stopped. Chrome session left open.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!stopping) console.log(`\n🛑 ${signal} received; stopping after the current rotation/wait...`);
    stopping = true;
  });
}

run().catch((error) => {
  console.error(`❌ FateDrop collector failed: ${error?.message || error}`);
  process.exitCode = 1;
});
