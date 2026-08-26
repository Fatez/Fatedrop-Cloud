export function learningEvidence({ disposition, aliasSignature, canonicalIdentityId = null } = {}) {
  return [
    { kind: "rrp_learning_disposition", value: disposition || "not_applicable" },
    ...(aliasSignature ? [{ kind: "rrp_alias_signature", value: aliasSignature }] : []),
    ...(canonicalIdentityId ? [{ kind: "rrp_canonical_identity", value: canonicalIdentityId }] : []),
  ];
}
