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
