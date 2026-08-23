const HOUR = 60 * 60;

export const RETAILER_FAILURE_COOLDOWNS = Object.freeze({
  access_blocked: 6 * HOUR,
  safety_cap: 6 * HOUR,
  zero_catalogue: 60 * 60,
  timeout: 30 * 60,
  other_failure: 15 * 60,
});

export function retailerFailureClass(error = "") {
  const text = String(error || "").toLowerCase();
  if (!text) return null;
  if (/blocked catalogue request \(403\)|access controls|\b403\b/.test(text)) return "access_blocked";
  if (/safety cap|above safety cap/.test(text)) return "safety_cap";
  if (/zero qualifying products|zero qualifying catalogue products|catalogue scan returned zero/.test(text)) return "zero_catalogue";
  if (/timed out|timeout/.test(text)) return "timeout";
  return "other_failure";
}

export function retailerCooldownDecision(retailer, health, {
  now = Math.floor(Date.now() / 1000),
  cooldowns = RETAILER_FAILURE_COOLDOWNS,
} = {}) {
  if (!retailer?.enabled) return { scan: false, reason: "retailer_disabled", retryAt: null, failureClass: null };
  if (!health || health.healthy !== false || !health.lastError || !Number.isFinite(Number(health.lastScanAt))) {
    return { scan: true, reason: null, retryAt: null, failureClass: null };
  }

  const failureClass = retailerFailureClass(health.lastError);
  const cooldown = cooldowns[failureClass] ?? cooldowns.other_failure;
  const retryAt = Math.floor(Number(health.lastScanAt)) + Math.max(0, Math.floor(cooldown || 0));
  if (now < retryAt) return { scan: false, reason: `cooldown:${failureClass}`, retryAt, failureClass };
  return { scan: true, reason: null, retryAt, failureClass };
}

export function selectRetailersForScan(retailers = [], healthRows = [], options = {}) {
  const healthById = new Map((healthRows || []).map((row) => [row.id || row.retailerId, row]));
  const active = [];
  const held = [];
  for (const retailer of retailers || []) {
    const decision = retailerCooldownDecision(retailer, healthById.get(retailer.id), options);
    if (decision.scan) active.push(retailer);
    else held.push({ retailerId: retailer.id, retailerName: retailer.name, ...decision });
  }
  return { active, held };
}
