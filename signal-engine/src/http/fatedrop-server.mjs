import { env } from "../config/env.mjs";
import { buildLocalRadar, normalizeEncounterBatch } from "../encounters/local-radar.mjs";
import { listEncountersFromStore, upsertEncountersIntoStore } from "../encounters/store.mjs";
import { createHttpServer as createLegacyHttpServer } from "./server.mjs";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function parseCsv(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function optionalNumber(params, name) {
  const raw = params.get(name);
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function eventFilters(url) {
  const from = url.searchParams.get("from") || new Date().toISOString();
  const to = url.searchParams.get("to") || null;
  const tcgs = parseCsv(url.searchParams.get("tcg")).map((value) => value.toLowerCase());
  const limit = Math.max(1, Math.min(2000, Number.parseInt(url.searchParams.get("limit") || "1000", 10) || 1000));
  return { from, to, tcgs, limit };
}

async function handleFateEncounters(req, res, { store, retailers, placesSearch }) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && ["/api/encounters", "/api/calendar-events"].includes(url.pathname)) {
    const events = await listEncountersFromStore(store, eventFilters(url));
    return json(res, 200, {
      success: true,
      count: events.length,
      generatedAt: new Date().toISOString(),
      events,
      disclaimer: "Event details can change. Check the organiser or ticket source before travelling.",
    });
  }

  if (req.method === "GET" && (url.pathname.startsWith("/api/encounters/") || url.pathname.startsWith("/api/calendar-events/"))) {
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const events = await listEncountersFromStore(store, { from: null, to: null, tcgs: [], limit: 2000 });
    const event = events.find((item) => item.id === id) || null;
    return event ? json(res, 200, { success: true, event }) : json(res, 404, { error: "Encounter not found" });
  }

  if (req.method === "GET" && url.pathname === "/api/local-radar") {
    const types = parseCsv(url.searchParams.get("types"));
    const radarStore = {
      listOffers: (options) => store.listOffers(options),
      listEncounters: (options) => listEncountersFromStore(store, options),
    };
    const result = await buildLocalRadar({
      store: radarStore,
      retailers,
      placesApiKey: env.encounters.googlePlacesApiKey,
      placesSearch,
      latitude: optionalNumber(url.searchParams, "lat"),
      longitude: optionalNumber(url.searchParams, "lng"),
      postcode: url.searchParams.get("postcode") || null,
      radiusMiles: optionalNumber(url.searchParams, "radiusMiles") || 25,
      tcg: url.searchParams.get("tcg") || null,
      types: types.length ? types : ["shops", "events"],
      from: url.searchParams.get("from") || new Date().toISOString(),
      to: url.searchParams.get("to") || null,
    });
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/internal/encounters") {
    if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) {
      return json(res, 401, { error: "Unauthorized" });
    }
    const body = await readBody(req);
    const normalized = normalizeEncounterBatch(body.events || []);
    if (!normalized.events.length) {
      return json(res, 400, {
        error: "No valid encounters supplied",
        rejected: normalized.rejected,
      });
    }
    const persisted = await upsertEncountersIntoStore(store, normalized.events);
    return json(res, 200, {
      success: true,
      persisted,
      received: normalized.received,
      accepted: normalized.accepted,
      unique: normalized.unique,
      rejected: normalized.rejected,
    });
  }

  return false;
}

export function createFateDropHttpServer({ store, retailers = [], placesSearch } = {}) {
  const server = createLegacyHttpServer({ store });
  const legacyHandler = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const isEncounterRoute = url.pathname === "/api/local-radar"
        || url.pathname === "/api/encounters"
        || url.pathname.startsWith("/api/encounters/")
        || url.pathname === "/api/calendar-events"
        || url.pathname.startsWith("/api/calendar-events/")
        || url.pathname === "/internal/encounters";
      if (isEncounterRoute) {
        await handleFateEncounters(req, res, { store, retailers, placesSearch });
        return;
      }
      return legacyHandler(req, res);
    } catch (error) {
      return json(res, 500, {
        error: "Fate Encounters error",
        detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined,
      });
    }
  });
  return server;
}
