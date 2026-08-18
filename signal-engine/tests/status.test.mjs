import test from "node:test";
import assert from "node:assert/strict";
import { classifyStockStatus } from "../src/core/status.mjs";

test("stock wording is deterministic", () => {
  assert.equal(classifyStockStatus("Add to basket").status, "in_stock");
  assert.equal(classifyStockStatus("SOLD OUT").status, "out_of_stock");
  assert.equal(classifyStockStatus("Coming soon - Notify me").status, "coming_soon");
  assert.equal(classifyStockStatus("Only 3 left").status, "low_stock");
});
