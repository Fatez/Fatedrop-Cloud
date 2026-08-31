import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../database/2026-08-31-local-radar-location-evidence.sql", import.meta.url), "utf8");

test("Local Radar v2 migration is additive and separates identity evidence from stock", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS retailer_category/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS tcg_seller_status/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_retailer_location_sources/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_retailer_location_conflicts/);
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im);
  assert.doesNotMatch(migration, /local_stock|stock_state|availability_state/i);
});

test("location conflicts remain explicit and unresolved by default", () => {
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'open'/);
  assert.match(migration, /CHECK \(status IN \('open','resolved','dismissed'\)\)/);
  assert.match(migration, /fatedrop_retailer_location_conflicts_open_idx/);
});
