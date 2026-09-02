import assert from "node:assert/strict";
import test from "node:test";

import { handleOperatorGlobalEchoRetractionHttp } from "../src/http/operator-global-echo-retraction-http.mjs";

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body ? JSON.parse(body) : null; },
  };
}

function request(url, body) {
  return { method: "POST", url, headers: { host: "localhost" }, _body: body };
}

const readJsonBody = async (req) => req._body;

test("unauthenticated retraction request is rejected before store access", async () => {
  const res = responseCapture();
  let touchedStore = false;
  const handled = await handleOperatorGlobalEchoRetractionHttp(request("/internal/operator-echo/retract", {}), res, {
    store: { async pool() { touchedStore = true; throw new Error("should not run"); } },
    ingestAuthorized: () => false,
    readJsonBody,
  });
  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.equal(touchedStore, false);
});

test("status endpoint returns null for active Echo and tombstone metadata for retracted Echo", async () => {
  const res = responseCapture();
  const store = {
    async pool() {
      return {
        async query() {
          return { rows: [{
            id: "operator-echo-retraction:local-radar-operator:8",
            kind: "operator_global_echo_retraction",
            occurred_at: 100,
            evidence_json: {
              schemaVersion: 1,
              status: "retracted",
              targetEventId: "local-radar-operator:8",
              retractedAt: "2026-09-02T13:00:00.000Z",
              retractedBy: "internal-owner-id",
              reason: "Wrong link",
              operatorIssue: 8,
            },
          }] };
        },
      };
    },
  };
  await handleOperatorGlobalEchoRetractionHttp(request("/internal/operator-echo/retraction-status", { eventIds: ["local-radar-operator:8", "local-radar-operator:9"] }), res, {
    store,
    ingestAuthorized: () => true,
    readJsonBody,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.retractions["local-radar-operator:8"].status, "retracted");
  assert.equal(res.body.retractions["local-radar-operator:8"].reason, "Wrong link");
  assert.equal("retractedBy" in res.body.retractions["local-radar-operator:8"], false, "consumer-facing status must not expose internal owner id");
  assert.equal(res.body.retractions["local-radar-operator:9"], null);
});
