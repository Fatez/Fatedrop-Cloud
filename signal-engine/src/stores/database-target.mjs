export function databaseNameFromUrl(databaseUrl) {
  try {
    const parsed = new URL(String(databaseUrl || ""));
    const pathname = decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "");
    const databaseName = pathname.split("/")[0]?.trim() || "";
    return databaseName || null;
  } catch {
    return null;
  }
}

export function assertProductionDatabaseTarget(databaseUrl, {
  railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME || "",
  expectedDatabaseName = process.env.FATEDROP_DATABASE_NAME || "neondb",
} = {}) {
  const production = String(railwayEnvironmentName).trim().toLowerCase() === "production";
  const expected = String(expectedDatabaseName || "").trim();
  const actual = databaseNameFromUrl(databaseUrl);

  if (!production) return { checked: false, actualDatabaseName: actual, expectedDatabaseName: expected || null };
  if (!expected) throw new Error("Production database target is not configured.");
  if (!actual) throw new Error("Production DATABASE_URL must include an explicit database name.");
  if (actual !== expected) {
    throw new Error(`Production DATABASE_URL must target "${expected}", received "${actual}".`);
  }

  return { checked: true, actualDatabaseName: actual, expectedDatabaseName: expected };
}
