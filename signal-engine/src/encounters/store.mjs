function dbEncounter(row) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    itemType: "event",
    name: row.name,
    description: row.description,
    startDateTime: row.start_at?.toISOString?.() || new Date(row.start_at).toISOString(),
    endDateTime: row.end_at ? (row.end_at.toISOString?.() || new Date(row.end_at).toISOString()) : null,
    venueName: row.venue_name,
    address: row.address,
    townCity: row.town_city,
    postcode: row.postcode,
    region: row.region,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    ticketPriceText: row.ticket_price_text,
    categories: row.categories || [],
    supportedTcgs: row.supported_tcgs || [],
    imageUrl: row.image_url,
    organiserName: row.organiser_name,
    officialEventUrl: row.official_event_url,
    officialTicketUrl: row.official_ticket_url,
    vendorInformationUrl: row.vendor_information_url,
    vendorApplicationsStatus: row.vendor_applications_status || "unknown",
    featured: row.featured === true,
    verificationStatus: row.verification_status,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    lastVerifiedAt: row.last_verified_at ? (row.last_verified_at.toISOString?.() || new Date(row.last_verified_at).toISOString()) : null,
  };
}

export async function listEncountersFromStore(store, { from = null, to = null, tcgs = [], limit = 1000 } = {}) {
  if (typeof store?.listEncounters === "function") return store.listEncounters({ from, to, tcgs, limit });
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const values = [];
  const conditions = [];
  if (from) { values.push(from); conditions.push(`start_at >= $${values.length}::timestamptz`); }
  if (to) { values.push(to); conditions.push(`start_at <= $${values.length}::timestamptz`); }
  if (tcgs.length) {
    values.push(tcgs.map((value) => String(value).toLowerCase()));
    conditions.push(`(supported_tcgs && $${values.length}::text[] OR supported_tcgs && ARRAY['all','all tcg']::text[])`);
  }
  values.push(Math.min(2000, Math.max(1, limit)));
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM fatedrop_encounters ${where} ORDER BY start_at ASC LIMIT $${values.length}`, values);
  return rows.map(dbEncounter);
}

export async function upsertEncountersIntoStore(store, events = []) {
  if (typeof store?.upsertEncounters === "function") return store.upsertEncounters(events);
  if (typeof store?.pool !== "function") throw new Error("Encounter persistence is unavailable");
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of events) {
      await client.query(`
        INSERT INTO fatedrop_encounters (
          id,canonical_key,name,description,start_at,end_at,venue_name,address,town_city,postcode,region,latitude,longitude,
          ticket_price_text,categories,supported_tcgs,image_url,organiser_name,official_event_url,official_ticket_url,
          vendor_information_url,vendor_applications_status,featured,verification_status,source_type,source_url,last_verified_at,updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW()
        )
        ON CONFLICT (canonical_key) DO UPDATE SET
          name=EXCLUDED.name,description=COALESCE(EXCLUDED.description,fatedrop_encounters.description),start_at=EXCLUDED.start_at,
          end_at=COALESCE(EXCLUDED.end_at,fatedrop_encounters.end_at),venue_name=COALESCE(EXCLUDED.venue_name,fatedrop_encounters.venue_name),
          address=COALESCE(EXCLUDED.address,fatedrop_encounters.address),town_city=COALESCE(EXCLUDED.town_city,fatedrop_encounters.town_city),
          postcode=COALESCE(EXCLUDED.postcode,fatedrop_encounters.postcode),region=COALESCE(EXCLUDED.region,fatedrop_encounters.region),
          latitude=COALESCE(EXCLUDED.latitude,fatedrop_encounters.latitude),longitude=COALESCE(EXCLUDED.longitude,fatedrop_encounters.longitude),
          ticket_price_text=COALESCE(EXCLUDED.ticket_price_text,fatedrop_encounters.ticket_price_text),
          categories=(SELECT ARRAY(SELECT DISTINCT unnest(fatedrop_encounters.categories || EXCLUDED.categories))),
          supported_tcgs=(SELECT ARRAY(SELECT DISTINCT unnest(fatedrop_encounters.supported_tcgs || EXCLUDED.supported_tcgs))),
          image_url=COALESCE(EXCLUDED.image_url,fatedrop_encounters.image_url),organiser_name=COALESCE(EXCLUDED.organiser_name,fatedrop_encounters.organiser_name),
          official_event_url=COALESCE(EXCLUDED.official_event_url,fatedrop_encounters.official_event_url),
          official_ticket_url=COALESCE(EXCLUDED.official_ticket_url,fatedrop_encounters.official_ticket_url),
          vendor_information_url=COALESCE(EXCLUDED.vendor_information_url,fatedrop_encounters.vendor_information_url),
          vendor_applications_status=EXCLUDED.vendor_applications_status,featured=EXCLUDED.featured,
          verification_status=EXCLUDED.verification_status,source_type=EXCLUDED.source_type,
          source_url=COALESCE(EXCLUDED.source_url,fatedrop_encounters.source_url),
          last_verified_at=COALESCE(EXCLUDED.last_verified_at,fatedrop_encounters.last_verified_at),updated_at=NOW()
      `, [
        event.id,event.canonicalKey,event.name,event.description,event.startDateTime,event.endDateTime,event.venueName,event.address,
        event.townCity,event.postcode,event.region,event.latitude,event.longitude,event.ticketPriceText,event.categories,event.supportedTcgs,
        event.imageUrl,event.organiserName,event.officialEventUrl,event.officialTicketUrl,event.vendorInformationUrl,event.vendorApplicationsStatus,
        event.featured,event.verificationStatus,event.sourceType,event.sourceUrl,event.lastVerifiedAt,
      ]);
    }
    await client.query("COMMIT");
    return { saved: events.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
