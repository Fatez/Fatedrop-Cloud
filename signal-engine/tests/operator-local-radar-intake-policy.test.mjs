import assert from "node:assert/strict";
import test from "node:test";

import { parseOperatorIssue } from "../src/encounters/operator-local-radar-intake.mjs";

const NOW = Date.parse("2026-08-30T22:00:00Z");

function issue(payload) {
  return {
    number: 9901,
    state: "open",
    title: "[FATEDROP LOCAL RADAR] Operator expected stock",
    body: JSON.stringify({
      schemaVersion: 1,
      retailerId: "the-entertainer",
      retailerName: "The Entertainer",
      rawProductTitle: "Pokemon TCG expected stock",
      targetBranches: ["Example branch"],
      expectedLabel: "expected tomorrow",
      expiresAt: "2026-09-01T22:00:00Z",
      ...payload,
    }),
    user: { login: "Fatez" },
    created_at: "2026-08-30T21:30:00Z",
    updated_at: "2026-08-30T21:30:00Z",
  };
}

test("authorised operator can explicitly publish credible expected-stock intelligence as Echo", () => {
  const parsed = parseOperatorIssue(issue({ kind: "echo", confidence: 0.75 }), NOW);
  assert.equal(parsed.entry.sourceType, "operator_manual");
  assert.equal(parsed.entry.kind, "echo");
  assert.equal(parsed.entry.confidence, 0.75);
});

test("manual operator intelligence remains Whisper unless Echo is explicitly requested", () => {
  const parsed = parseOperatorIssue(issue({ confidence: 0.75 }), NOW);
  assert.equal(parsed.entry.kind, "whisper");
  assert.equal(parsed.entry.confidence, 0.59);
});
