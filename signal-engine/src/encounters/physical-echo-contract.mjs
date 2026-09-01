const INPUT_LOCAL_KINDS = new Set(["whisper", "echo", "manifested", "vanished"]);
const PHYSICAL_EVIDENCE_STATES = new Set(["expected", "reported", "verified", "expired"]);
const OFFICIAL_EVIDENCE_LEVELS = new Set(["official_branch", "official_collection", "official_retailer_app"]);
const VERIFIED_AVAILABILITY = new Set(["in_stock", "low_stock", "available", "collection_available", "on_shelf"]);
const REPORTED_SOURCES = new Set(["retailer_staff_report", "official_store_social", "retailer_submission", "community_report", "community_sighting", "verified_shelf_sighting"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function validateVerified({ locationId, productIdentityId, evidenceLevel, stockStatus, evidence }) {
  if (!locationId) throw new Error("Physical verified Echo requires an exact retailer location");
  if (!productIdentityId) throw new Error("Physical verified Echo requires canonical product identity");
  if (!OFFICIAL_EVIDENCE_LEVELS.has(evidenceLevel)) throw new Error("Physical verified Echo requires official branch/collection/app evidence");
  if (evidence.availabilityVerified !== true && !VERIFIED_AVAILABILITY.has(stockStatus)) {
    throw new Error("Physical verified Echo requires fresh verified branch availability evidence");
  }
}

export function resolvePhysicalEchoEvidenceState({
  requestedKind,
  evidence = {},
  evidenceLevel = "unknown",
  sourceType = null,
  stockStatus = null,
  locationId = null,
  productIdentityId = null,
} = {}) {
  const kind = text(requestedKind)?.toLowerCase();
  if (!INPUT_LOCAL_KINDS.has(kind)) throw new Error("Local stock observation requires a recognised legacy/local signal kind");
  const explicit = text(evidence.physicalEvidenceState ?? evidence.physical_evidence_state)?.toLowerCase();
  if (explicit && !PHYSICAL_EVIDENCE_STATES.has(explicit)) throw new Error("Invalid physical evidence state");

  const state = explicit
    || ((evidenceLevel === "community_report" || REPORTED_SOURCES.has(sourceType)) ? "reported" : null)
    || (kind === "manifested" ? "verified" : null)
    || (kind === "vanished" ? "expired" : null)
    || ((evidence.availabilityVerified === true || VERIFIED_AVAILABILITY.has(stockStatus)) ? "verified" : null)
    || "expected";

  if (state === "verified") validateVerified({ locationId, productIdentityId, evidenceLevel, stockStatus, evidence });
  if (state === "expired" && (!locationId || !productIdentityId)) {
    throw new Error("Physical expired Echo requires an exact branch and canonical product identity");
  }
  return state;
}

export const PHYSICAL_ECHO_CONTRACT = Object.freeze({
  alertChannel: "echo",
  availabilityScopes: ["physical_branch", "physical_retailer_chain"],
  evidenceStates: [...PHYSICAL_EVIDENCE_STATES],
  legacyInputs: [...INPUT_LOCAL_KINDS],
  rule: "All physical/in-store intelligence is canonical Echo. Physical evidence never creates Manifested or ordinary Vanished.",
});
