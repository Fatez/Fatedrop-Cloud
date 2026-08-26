export function rrpLearningTelemetry({ disposition, retailerId, title, productType } = {}) {
  return {
    disposition: disposition || "not_applicable",
    retailerId: retailerId || null,
    title: title || null,
    productType: productType || null,
  };
}
