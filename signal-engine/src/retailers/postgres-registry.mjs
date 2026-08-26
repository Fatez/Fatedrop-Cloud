import { normalizeRetailerCandidate } from "./registry.mjs";

function toEpoch(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

function fromRow(row) {
  return normalizeRetailerCandidate({
    id: row.retailer_id,
    name: row.retailer_name,
    websiteUrl: row.website_url,
    retailerClass: row.retailer_class,
    adapterType: row.adapter_type,
    state: row.lifecycle_state,
    verification: row.verification_state,
    rrpAuthority: row.rrp_authority,
    tcgs: row.tcgs,
    online: row.online,
    physicalLocations: row.physical_locations,
    catalogue: row.catalogue_config,
    delivery: row.delivery_policy,
    monitoring: row.monitoring_policy,
    discovery: row.discovery,
  });
}

export class PostgresRetailerRegistry {
  constructor(databaseUrl) { this.databaseUrl = databaseUrl; this.poolPromise = null; }
  async pool() {
    if (!this.poolPromise) this.poolPromise = import("pg").then(({ Pool }) => new Pool({ connectionString: this.databaseUrl, ssl: this.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false } }));
    return this.poolPromise;
  }

  async upsert(input, now = Math.floor(Date.now() / 1000)) {
    const retailer = normalizeRetailerCandidate(input);
    if (!retailer.id || !retailer.websiteUrl || !retailer.hostname) throw new Error("Retailer registry requires id, websiteUrl and hostname");
    const pool = await this.pool();
    const discoveredAt = toEpoch(retailer.discovery.discoveredAt);
    const { rows } = await pool.query(`
      INSERT INTO fatedrop_retailer_registry (
        retailer_id, retailer_name, website_url, hostname, country_code, retailer_class,
        adapter_type, lifecycle_state, verification_state, rrp_authority, tcgs, online,
        physical_locations, catalogue_config, delivery_policy, monitoring_policy, discovery,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'GB',$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18)
      ON CONFLICT (retailer_id) DO UPDATE SET
        retailer_name=EXCLUDED.retailer_name,
        website_url=EXCLUDED.website_url,
        hostname=EXCLUDED.hostname,
        retailer_class=EXCLUDED.retailer_class,
        adapter_type=EXCLUDED.adapter_type,
        lifecycle_state=EXCLUDED.lifecycle_state,
        verification_state=EXCLUDED.verification_state,
        rrp_authority=EXCLUDED.rrp_authority,
        tcgs=EXCLUDED.tcgs,
        online=EXCLUDED.online,
        physical_locations=EXCLUDED.physical_locations,
        catalogue_config=EXCLUDED.catalogue_config,
        delivery_policy=EXCLUDED.delivery_policy,
        monitoring_policy=EXCLUDED.monitoring_policy,
        discovery=EXCLUDED.discovery,
        updated_at=EXCLUDED.updated_at
      RETURNING *
    `, [
      retailer.id, retailer.name, retailer.websiteUrl, retailer.hostname, retailer.retailerClass,
      retailer.adapterType, retailer.state, retailer.verification, retailer.rrpAuthority,
      JSON.stringify(retailer.tcgs), retailer.online, retailer.physicalLocations,
      JSON.stringify(retailer.catalogue), JSON.stringify(retailer.delivery), JSON.stringify(retailer.monitoring),
      JSON.stringify({ ...retailer.discovery, discoveredAt: new Date(discoveredAt * 1000).toISOString() }), now, now,
    ]);
    return fromRow(rows[0]);
  }

  async get(retailerId) {
    const pool = await this.pool();
    const { rows } = await pool.query("SELECT * FROM fatedrop_retailer_registry WHERE retailer_id=$1", [retailerId]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list({ states = [], classes = [], adapters = [], limit = 1000 } = {}) {
    const pool = await this.pool();
    const conditions = [];
    const values = [];
    if (states.length) { values.push(states); conditions.push(`lifecycle_state = ANY($${values.length})`); }
    if (classes.length) { values.push(classes); conditions.push(`retailer_class = ANY($${values.length})`); }
    if (adapters.length) { values.push(adapters); conditions.push(`adapter_type = ANY($${values.length})`); }
    values.push(Math.min(5000, Math.max(1, limit)));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(`SELECT * FROM fatedrop_retailer_registry ${where} ORDER BY retailer_name LIMIT $${values.length}`, values);
    return rows.map(fromRow);
  }

  async latestMonitorRunTimes({ retailerIds = [], mode = null } = {}) {
    if (!retailerIds.length) return new Map();
    const pool = await this.pool();
    const values = [retailerIds];
    let modeFilter = "";
    if (mode) {
      values.push(mode);
      modeFilter = `AND diagnostics->>'mode' = $${values.length}`;
    }
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (retailer_id) retailer_id, COALESCE(completed_at, started_at) AS observed_at
      FROM fatedrop_retailer_monitor_runs
      WHERE retailer_id = ANY($1) ${modeFilter}
      ORDER BY retailer_id, COALESCE(completed_at, started_at) DESC
    `, values);
    return new Map(rows.map((row) => [row.retailer_id, Number(row.observed_at)]));
  }

  async recordDiscoveryEvidence({ evidenceId, retailerId, sourceType, sourceUrl = null, observedAt = Math.floor(Date.now() / 1000), evidence = {} }) {
    const pool = await this.pool();
    await pool.query(`
      INSERT INTO fatedrop_retailer_discovery_evidence (evidence_id, retailer_id, source_type, source_url, observed_at, evidence)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (retailer_id, source_type, source_url) DO UPDATE SET observed_at=EXCLUDED.observed_at,evidence=EXCLUDED.evidence
    `, [evidenceId, retailerId, sourceType, sourceUrl, observedAt, JSON.stringify(evidence)]);
  }

  async recordMonitorRun(run) {
    const pool = await this.pool();
    await pool.query(`
      INSERT INTO fatedrop_retailer_monitor_runs (run_id,retailer_id,started_at,completed_at,status,pages_scanned,products_observed,catalogue_complete,published,failure_code,failure_detail,diagnostics)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [run.runId,run.retailerId,run.startedAt,run.completedAt ?? null,run.status,run.pagesScanned ?? 0,run.productsObserved ?? 0,run.catalogueComplete === true,run.published === true,run.failureCode ?? null,run.failureDetail ?? null,JSON.stringify(run.diagnostics || {})]);
  }
}
