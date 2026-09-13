export function assessProviderEnvelope(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const totalItems = Number(payload?.totalItems);
  const totalMatches = !Number.isFinite(totalItems) || totalItems === results.length;
  const paginationKeys = ['nextPage', 'previousPage', 'page', 'pageSize', 'totalPages', 'pagination', 'next'];
  const noPagination = paginationKeys.every(key => payload?.[key] == null);
  return {
    results,
    errors,
    totalMatches,
    noPagination,
    complete: payload?.success === true && errors.length === 0 && totalMatches && noPagination,
  };
}
