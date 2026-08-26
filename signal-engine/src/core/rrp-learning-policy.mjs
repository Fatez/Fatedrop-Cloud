export function rrpLearningDisposition({ rrpResolved, rememberedAlias, queuedUnknown, conflict = false } = {}) {
  if (rrpResolved && rememberedAlias) return "resolved_from_memory";
  if (rrpResolved) return "resolved";
  if (conflict) return "conflict";
  if (queuedUnknown) return "queued_unknown";
  return "not_applicable";
}
