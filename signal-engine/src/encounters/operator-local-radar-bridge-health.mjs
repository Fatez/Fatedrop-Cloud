function text(value, max = 1000) {
  const result = typeof value === "string" ? value.trim().slice(0, max) : "";
  return result || null;
}

export async function probeOperatorLocalRadarBridge(fetchImpl = fetch) {
  const snapshotUrl = text(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL);
  const secret = text(process.env.FATEDROP_METRICS_INGEST_SECRET);
  if (!snapshotUrl || !secret) {
    return { configured: false, reachable: false, status: "not_configured" };
  }

  let target;
  try {
    target = new URL("/api/dashboard/local-radar-operator-alert", snapshotUrl).toString();
  } catch {
    return { configured: false, reachable: false, status: "invalid_url" };
  }

  try {
    const response = await fetchImpl(target, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 204) return { configured: true, reachable: true, status: "ready" };
    if (response.status === 401 || response.status === 403) return { configured: true, reachable: false, status: "unauthorized" };
    if (response.status === 503) return { configured: true, reachable: false, status: "push_unhealthy" };
    return { configured: true, reachable: false, status: "unexpected_response" };
  } catch {
    return { configured: true, reachable: false, status: "unreachable" };
  }
}
