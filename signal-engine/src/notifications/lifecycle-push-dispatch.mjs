const DEFAULT_PRODUCTION_URL = "https://fatedrop.co.uk/api/dashboard/push-dispatch";
const PUSH_DISPATCH_PATH = "/api/dashboard/push-dispatch";

function text(value) {
  return String(value ?? "").trim();
}

function dispatchUrlFromSnapshot(snapshotUrl) {
  const value = text(snapshotUrl);
  if (!value) return "";
  try {
    return new URL(PUSH_DISPATCH_PATH, value).toString();
  } catch {
    return "";
  }
}

export function lifecyclePushDispatchConfig({
  environmentName = process.env.RAILWAY_ENVIRONMENT_NAME || "",
  store = process.env.FATEDROP_SIGNAL_STORE || "file",
  databaseUrl = process.env.DATABASE_URL || "",
  url = process.env.FATEDROP_WEB_PUSH_DISPATCH_URL || "",
  snapshotUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL || "",
  secret = process.env.FATEDROP_METRICS_INGEST_SECRET || "",
} = {}) {
  const productionPostgres = text(environmentName).toLowerCase() === "production"
    && text(store).toLowerCase() === "postgres"
    && Boolean(text(databaseUrl));
  const resolvedUrl = text(url)
    || dispatchUrlFromSnapshot(snapshotUrl)
    || (productionPostgres ? DEFAULT_PRODUCTION_URL : "");
  const resolvedSecret = text(secret);
  return {
    configured: Boolean(resolvedUrl && resolvedSecret),
    url: resolvedUrl,
    secret: resolvedSecret,
  };
}

export async function triggerLifecyclePushDispatch({
  fetchImpl = fetch,
  config = lifecyclePushDispatchConfig(),
} = {}) {
  if (!config?.configured) return { configured: false, triggered: false };

  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secret}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        configured: true,
        triggered: false,
        httpStatus: response.status,
        error: typeof result?.error === "string" ? result.error : `push-dispatch-http-${response.status}`,
      };
    }
    return { configured: true, triggered: true, httpStatus: response.status, result };
  } catch (error) {
    return {
      configured: true,
      triggered: false,
      error: String(error?.message || error || "push-dispatch-failed"),
    };
  }
}
