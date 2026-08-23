import test from "node:test";
import assert from "node:assert/strict";
import { BrowserState, classifyBrowserState, nextCollectorFailureState, readinessReportTransition, remainingCycleDelay } from "../src/runtime.mjs";

test("rotation waits only for the remainder of a 60 second cycle", () => {
  assert.equal(remainingCycleDelay({ startedAtMs: 1_000, nowMs: 41_000, minimumCycleMs: 60_000 }), 20_000);
  assert.equal(remainingCycleDelay({ startedAtMs: 1_000, nowMs: 71_000, minimumCycleMs: 60_000 }), 0);
});

test("browser state classifies queue and security pages without attempting bypass", () => {
  assert.equal(classifyBrowserState({ url: "https://example.queue-it.net/", title: "Waiting Room", text: "You are now in line" }), BrowserState.QUEUE);
  assert.equal(classifyBrowserState({ url: "https://www.pokemoncenter.com/en-gb/", title: "Security check", text: "Verify you are human" }), BrowserState.SECURITY);
  assert.equal(classifyBrowserState({ url: "https://www.pokemoncenter.com/en-gb/search/tcg-cards", title: "Trading Card Game", text: "Products" }), BrowserState.NORMAL);
});

test("initial non-normal readiness state is reportable exactly as an unknown-to-readiness transition", () => {
  for (const state of [BrowserState.QUEUE, BrowserState.SECURITY, BrowserState.ACCESS_BLOCKED]) {
    assert.deepEqual(readinessReportTransition({ previousState: null, state }), { report: true, previousState: "unknown" });
  }
  assert.deepEqual(readinessReportTransition({ previousState: null, state: BrowserState.NORMAL }), { report: false, previousState: null });
  assert.deepEqual(readinessReportTransition({ previousState: null, state: BrowserState.UNEXPECTED }), { report: false, previousState: null });
});

test("later readiness transitions preserve the actually observed previous browser state", () => {
  assert.deepEqual(readinessReportTransition({ previousState: BrowserState.NORMAL, state: BrowserState.QUEUE }), { report: true, previousState: BrowserState.NORMAL });
  assert.deepEqual(readinessReportTransition({ previousState: BrowserState.QUEUE, state: BrowserState.SECURITY }), { report: true, previousState: BrowserState.QUEUE });
});

test("three consecutive normal-state failures recycle a stuck collector", () => {
  let state = nextCollectorFailureState({ consecutiveFailures: 0, browserState: BrowserState.NORMAL, maxFailures: 3 });
  assert.deepEqual(state, { consecutiveFailures: 1, recycle: false });
  state = nextCollectorFailureState({ consecutiveFailures: state.consecutiveFailures, browserState: BrowserState.NORMAL, maxFailures: 3 });
  assert.deepEqual(state, { consecutiveFailures: 2, recycle: false });
  state = nextCollectorFailureState({ consecutiveFailures: state.consecutiveFailures, browserState: BrowserState.NORMAL, maxFailures: 3 });
  assert.deepEqual(state, { consecutiveFailures: 3, recycle: true });
});

test("queue, security and access-control states never trigger failure recycling", () => {
  for (const browserState of [BrowserState.QUEUE, BrowserState.SECURITY, BrowserState.ACCESS_BLOCKED, BrowserState.UNEXPECTED]) {
    assert.deepEqual(nextCollectorFailureState({ consecutiveFailures: 2, browserState, maxFailures: 3 }), { consecutiveFailures: 0, recycle: false });
  }
});
