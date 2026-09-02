import {
  readManualGlobalEchoRetractions,
  retractManualGlobalEcho,
} from "../encounters/operator-global-echo-retraction.mjs";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function errorStatus(error) {
  if (error?.code === "OWNER_REQUIRED") return 403;
  if (error?.code === "ECHO_NOT_FOUND") return 404;
  if (error?.code === "ECHO_NOT_RETRACTABLE") return 409;
  if (error?.code === "EVENT_REQUIRED" || error?.code === "REASON_REQUIRED") return 400;
  return 503;
}

function retractionPublicStatus(retraction) {
  if (!retraction) return null;
  return {
    status: "retracted",
    targetEventId: retraction.targetEventId,
    retractedAt: retraction.retractedAt,
    reason: retraction.reason,
    operatorIssue: retraction.operatorIssue,
  };
}

export async function handleOperatorGlobalEchoRetractionHttp(req, res, {
  store,
  ingestAuthorized,
  readJsonBody,
} = {}) {
  if (!req || !res || typeof readJsonBody !== "function" || typeof ingestAuthorized !== "function") return false;
  const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
  const retractPath = "/internal/operator-echo/retract";
  const statusPath = "/internal/operator-echo/retraction-status";
  if (req.method !== "POST" || (url.pathname !== retractPath && url.pathname !== statusPath)) return false;

  if (!ingestAuthorized(req)) {
    json(res, 401, { success: false, error: "Unauthorized" });
    return true;
  }

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: 32 * 1024 });
  } catch {
    json(res, 400, { success: false, error: "Invalid JSON request body" });
    return true;
  }

  if (url.pathname === statusPath) {
    const eventIds = Array.isArray(body?.eventIds) ? body.eventIds : [];
    if (!eventIds.length || eventIds.length > 100) {
      json(res, 400, { success: false, error: "eventIds must contain 1-100 event ids" });
      return true;
    }
    try {
      const retractions = await readManualGlobalEchoRetractions({ store, eventIds });
      const result = {};
      for (const rawId of eventIds) {
        const eventId = typeof rawId === "string" ? rawId.trim().slice(0, 180) : "";
        if (eventId) result[eventId] = retractionPublicStatus(retractions.get(eventId) || null);
      }
      json(res, 200, { success: true, retractions: result });
    } catch {
      json(res, 503, { success: false, error: "Retraction status is unavailable" });
    }
    return true;
  }

  try {
    const result = await retractManualGlobalEcho({
      store,
      eventId: typeof body?.eventId === "string" ? body.eventId : "",
      reason: typeof body?.reason === "string" ? body.reason : "",
      retractedBy: typeof body?.retractedBy === "string" ? body.retractedBy : "",
    });
    json(res, 200, {
      success: true,
      eventId: result.eventId,
      duplicate: result.duplicate,
      retraction: retractionPublicStatus(result.retraction),
    });
  } catch (error) {
    json(res, errorStatus(error), { success: false, error: String(error?.message || "Retraction failed"), code: error?.code || "RETRACTION_FAILED" });
  }
  return true;
}
