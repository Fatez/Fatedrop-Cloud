const PRODUCTION_WEB_ORIGIN = "https://fatedrop.co.uk";
export const OPERATOR_LOCAL_RADAR_BRIDGE_CONTRACT_VERSION = 2;

function text(value, max = 1000) {
  const result = typeof value === "string" ? value.trim().slice(0, max) : "";
  return result || null;
}

export function operatorLocalRadarBridgeConfig() {
  const configuredUrl = text(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL);
  const productionFallback = process.env.RAILWAY_ENVIRONMENT_NAME === "production"
    ? PRODUCTION_WEB_ORIGIN
    : null;
  const snapshotUrl = configuredUrl || productionFallback;
  const secret = text(process.env.FATEDROP_METRICS_INGEST_SECRET);
  return {
    contractVersion: OPERATOR_LOCAL_RADAR_BRIDGE_CONTRACT_VERSION,
    snapshotUrl,
    secret,
    configured: Boolean(snapshotUrl && secret),
    secretConfigured: Boolean(secret),
    urlSource: configuredUrl ? "environment" : (productionFallback ? "production_default" : "missing"),
  };
}

export async function probeOperatorLocalRadarBridge(fetchImpl = fetch) {
  const config = operatorLocalRadarBridgeConfig();
  if (!config.snapshotUrl) {
    return { configured: false, reachable: false, status: "missing_url" };
  }
  if (!config.secretConfigured) {
    return { configured: false, reachable: false, status: "missing_secret" };
  }

  let target;
  try {
    target = new URL("/api/dashboard/local-radar-operator-alert", config.snapshotUrl).toString();
  } catch {
    return { configured: false, reachable: false, status: "invalid_url" };
  }

  try {
    const response = await fetchImpl(target, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.secret}`,
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
