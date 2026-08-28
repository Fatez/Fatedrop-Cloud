import { triggerLifecyclePushDispatch } from "./lifecycle-push-dispatch.mjs";

export const LIFECYCLE_PUSH_DISPATCH_INTERVAL_MS = 60 * 1000;
export const LIFECYCLE_PUSH_DISPATCH_START_DELAY_MS = 5 * 1000;

let dispatching = false;

export async function runLifecyclePushDispatchHeartbeat() {
  if (dispatching) return { skipped: true, reason: "dispatch_in_progress" };
  dispatching = true;
  try {
    const outcome = await triggerLifecyclePushDispatch();
    if (outcome.configured && !outcome.triggered) {
      console.error("[signal-engine] lifecycle push dispatch heartbeat failed", {
        httpStatus: outcome.httpStatus || null,
        error: outcome.error || "unknown",
      });
    } else if (outcome.triggered) {
      const result = outcome.result || {};
      if (Number(result.queued || 0) > 0 || Number(result.claimed || 0) > 0 || Number(result.failed || 0) > 0) {
        console.log("[signal-engine] lifecycle push dispatch heartbeat", {
          queued: Number(result.queued || 0),
          claimed: Number(result.claimed || 0),
          sent: Number(result.sent || 0),
          failed: Number(result.failed || 0),
        });
      }
    }
    return outcome;
  } finally {
    dispatching = false;
  }
}

const startTimer = setTimeout(() => { void runLifecyclePushDispatchHeartbeat(); }, LIFECYCLE_PUSH_DISPATCH_START_DELAY_MS);
startTimer.unref();
setInterval(runLifecyclePushDispatchHeartbeat, LIFECYCLE_PUSH_DISPATCH_INTERVAL_MS).unref();
