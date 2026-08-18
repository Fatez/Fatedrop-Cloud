import http from "node:http";
import { env } from "../config/env.mjs";
import { retailers } from "../config/retailers.mjs";
import { ingestRetailerProducts, scanAll } from "../core/engine.mjs";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function unauthorized(res) { json(res, 401, { error: "Unauthorized" }); }
function tokenFrom(req) { const auth=req.headers.authorization||""; return auth.startsWith("Bearer ") ? auth.slice(7) : ""; }
function parseCsv(value) { return value ? value.split(",").map((x)=>x.trim()).filter(Boolean) : []; }
async function readBody(req) { let raw=""; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("Body too large"); } return raw ? JSON.parse(raw) : {}; }

export function createHttpServer({ store }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "fatedrop-signal-engine", version: "0.1.0" });
      if (req.method === "GET" && url.pathname === "/v1/network") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        return json(res, 200, { generatedAt: Math.floor(Date.now()/1000), stats: await store.stats(), retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/retailers") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        return json(res, 200, { retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/network/history") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        const limit = Math.max(1, Math.min(180, Number.parseInt(url.searchParams.get("limit") || "30", 10)));
        return json(res, 200, { snapshots: await store.listNetworkSnapshots(limit) });
      }
      if (req.method === "GET" && url.pathname === "/v1/signals") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        const limit = Math.max(1, Math.min(250, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
        const since = Math.max(0, Number.parseInt(url.searchParams.get("since") || "0", 10));
        const signals = await store.listSignals({ states: parseCsv(url.searchParams.get("state")), retailerIds: parseCsv(url.searchParams.get("retailer")), since, limit });
        return json(res, 200, { generatedAt: Math.floor(Date.now()/1000), signals });
      }
      if (req.method === "POST" && url.pathname === "/internal/scan") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const selected = body.retailerIds?.length ? retailers.filter((r)=>body.retailerIds.includes(r.id)) : retailers;
        return json(res, 200, { results: await scanAll({ retailers: selected, store }) });
      }
      if (req.method === "POST" && url.pathname === "/internal/ingest") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const retailer = retailers.find((item) => item.id === body.retailerId);
        if (!retailer) return json(res, 400, { error: "Unknown or disabled retailer" });
        if (!Array.isArray(body.products) || body.products.length === 0) return json(res, 400, { error: "products must be a non-empty array" });
        const result = await ingestRetailerProducts({ retailer, store, products: body.products });
        return json(res, 200, { result });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) { return json(res, 500, { error: "Signal engine error", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined }); }
  });
}
