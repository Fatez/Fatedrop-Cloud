import { AsyncLocalStorage } from "node:async_hooks";

const retailerScanContext = new AsyncLocalStorage();

export function currentRetailerScanSignal() {
  return retailerScanContext.getStore()?.signal ?? null;
}

export function retailerScanDeadlineError(retailerId, timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
  const error = new Error(`Retailer scan timed out at the ${seconds}s hard deadline${retailerId ? ` (${retailerId})` : ""}; aborting this adapter so the network scheduler can continue.`);
  error.code = "retailer_scan_deadline";
  return error;
}

export async function runWithRetailerScanDeadline(fn, {
  retailerId = null,
  timeoutMs,
} = {}) {
  const safeTimeoutMs = Math.max(10, Math.round(Number(timeoutMs) || 0));
  const controller = new AbortController();
  const deadlineError = retailerScanDeadlineError(retailerId, safeTimeoutMs);
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(deadlineError);
      reject(deadlineError);
    }, safeTimeoutMs);
  });

  try {
    return await retailerScanContext.run(
      { retailerId, signal: controller.signal, deadlineAt: Date.now() + safeTimeoutMs },
      () => Promise.race([Promise.resolve().then(fn), timeout]),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function throwIfRetailerScanAborted() {
  const signal = currentRetailerScanSignal();
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : retailerScanDeadlineError(null, 0);
}
