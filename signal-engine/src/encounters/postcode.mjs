function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactPostcode(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function postcodeResult(requested, result) {
  const latitude = number(result?.latitude);
  const longitude = number(result?.longitude);
  if (latitude == null || longitude == null) {
    return {
      status: "invalid",
      source: "postcodes_io",
      postcode: text(result?.postcode) || text(requested)?.toUpperCase() || null,
      latitude: null,
      longitude: null,
    };
  }
  return {
    status: "ok",
    source: "postcodes_io",
    postcode: text(result?.postcode) || text(requested)?.toUpperCase() || null,
    latitude,
    longitude,
    region: text(result?.region),
    country: text(result?.country),
    district: text(result?.admin_district),
  };
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

  try {
    const response = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(compactPostcode(requested))}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return postcodeResult(requested, null);
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
    return postcodeResult(requested, data?.result);
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

export async function lookupUkPostcodes({ postcodes = [], fetchImpl = fetch } = {}) {
  const requested = [...new Set(postcodes.map((value) => text(value)).filter(Boolean))];
  const resolved = new Map();
  if (!requested.length) return resolved;

  for (let index = 0; index < requested.length; index += 100) {
    const batch = requested.slice(index, index + 100);
    try {
      const response = await fetchImpl("https://api.postcodes.io/postcodes?filter=postcode,longitude,latitude,region,country,admin_district", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ postcodes: batch }),
      });
      if (!response.ok) {
        for (const postcode of batch) {
          resolved.set(compactPostcode(postcode), {
            status: "unavailable",
            source: "postcodes_io",
            postcode: postcode.toUpperCase(),
            latitude: null,
            longitude: null,
          });
        }
        continue;
      }
      const data = await response.json();
      const rows = Array.isArray(data?.result) ? data.result : [];
      const byQuery = new Map(rows.map((row) => [compactPostcode(row?.query), row?.result || null]));
      for (const postcode of batch) {
        resolved.set(compactPostcode(postcode), postcodeResult(postcode, byQuery.get(compactPostcode(postcode))));
      }
    } catch {
      for (const postcode of batch) {
        resolved.set(compactPostcode(postcode), {
          status: "unavailable",
          source: "postcodes_io",
          postcode: postcode.toUpperCase(),
          latitude: null,
          longitude: null,
        });
      }
    }
  }

  return resolved;
}
