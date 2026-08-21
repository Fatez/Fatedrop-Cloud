function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function lookupUkPostcode({ postcode, fetchImpl = fetch } = {}) {
  const requested = text(postcode);
  if (!requested) {
    return {
      status: "not_requested",
      source: "postcodes_io",
      postcode: null,
      latitude: null,
      longitude: null,
    };
  }

  const compact = requested.replace(/\s+/g, "").toUpperCase();
  try {
    const response = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      return {
        status: "invalid",
        source: "postcodes_io",
        postcode: requested.toUpperCase(),
        latitude: null,
        longitude: null,
      };
    }
    if (!response.ok) {
      return {
        status: "unavailable",
        source: "postcodes_io",
        postcode: requested.toUpperCase(),
        latitude: null,
        longitude: null,
      };
    }

    const data = await response.json();
    const latitude = number(data?.result?.latitude);
    const longitude = number(data?.result?.longitude);
    if (latitude == null || longitude == null) {
      return {
        status: "unavailable",
        source: "postcodes_io",
        postcode: text(data?.result?.postcode) || requested.toUpperCase(),
        latitude: null,
        longitude: null,
      };
    }

    return {
      status: "ok",
      source: "postcodes_io",
      postcode: text(data?.result?.postcode) || requested.toUpperCase(),
      latitude,
      longitude,
      region: text(data?.result?.region),
      country: text(data?.result?.country),
      district: text(data?.result?.admin_district),
    };
  } catch {
    return {
      status: "unavailable",
      source: "postcodes_io",
      postcode: requested.toUpperCase(),
      latitude: null,
      longitude: null,
    };
  }
}
