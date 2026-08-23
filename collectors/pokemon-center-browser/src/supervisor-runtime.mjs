export function supervisorProbeUrl(cdpUrl) {
  const url = new URL(cdpUrl || "http://127.0.0.1:9222");
  url.pathname = "/json/version";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function supervisorIntervalMs(raw, fallback = 10_000) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Math.max(5_000, Number.isFinite(parsed) ? parsed : fallback);
}

export function supervisorProbeTimeoutMs(raw, fallback = 3_000) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Math.max(1_000, Math.min(10_000, Number.isFinite(parsed) ? parsed : fallback));
}

export function supervisorRestartDelayMs(restartCount, { baseMs = 60_000, maxMs = 1_800_000 } = {}) {
  const count = Math.max(0, Math.min(10, Math.trunc(Number(restartCount) || 0)));
  const safeBase = Math.max(30_000, Math.trunc(Number(baseMs) || 60_000));
  const safeMax = Math.max(safeBase, Math.min(3_600_000, Math.trunc(Number(maxMs) || 1_800_000)));
  return Math.min(safeMax, safeBase * (2 ** count));
}

export function supervisorAccessCooldownMs(kind, overrides = {}) {
  const defaults = {
    queue: 300_000,
    security: 900_000,
    access_blocked: 3_600_000,
  };
  const minimums = {
    queue: 120_000,
    security: 300_000,
    access_blocked: 900_000,
  };
  const value = Number(overrides[kind]);
  const fallback = defaults[kind] ?? 600_000;
  const minimum = minimums[kind] ?? 300_000;
  return Math.max(minimum, Math.min(7_200_000, Number.isFinite(value) ? Math.trunc(value) : fallback));
}
