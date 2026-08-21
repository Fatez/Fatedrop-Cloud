export class PostgresStore {
  constructor(databaseUrl) { this.databaseUrl = databaseUrl; this.poolPromise = null; }
  async pool() {
    if (!this.poolPromise) this.poolPromise = import("pg").then(({ Pool }) => new Pool({ connectionString: this.databaseUrl, ssl: this.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false } }));
    return this.poolPromise;
  }
  async getOffer(offerId) {
    const pool = await this.pool();
    const { rows } = await pool.query("SELECT * FROM fatedrop_retail_offers WHERE offer_id=$1", [offerId]);
    if (!rows[0]) return null;
    return dbOffer(rows[0]);
  }
  async getProduct(productId) {
    const pool = await this.pool();
    const { rows } = await pool.query("SELECT * FROM fatedrop_products WHERE id=$1", [productId]);
    return rows[0] ? dbProduct(rows[0]) : null;
  }
  async listOffers({ limit = 5000 } = {}) {
    const pool = await this.pool();
    const safe = Math.min(10000, Math.max(1, limit));
    const { rows } = await pool.query("SELECT * FROM fatedrop_retail_offers ORDER BY last_seen_at DESC LIMIT $1", [safe]);
    return rows.map(dbOffer);
  }
  async listProducts({ rrpSource = null, limit = 2000 } = {}) {
    const pool = await this.pool();
    const safe = Math.min(5000, Math.max(1, limit));
    const { rows } = rrpSource
      ? await pool.query("SELECT * FROM fatedrop_products WHERE rrp_source=$1 ORDER BY updated_at DESC LIMIT $2", [rrpSource, safe])
      : await pool.query("SELECT * FROM fatedrop_products ORDER BY updated_at DESC LIMIT $1", [safe]);
    return rows.map(dbProduct);
  }
  async isBaselineComplete(retailerId) {
    const pool = await this.pool();
    const { rows } = await pool.query("SELECT baseline_completed FROM fatedrop_retailer_health WHERE retailer_id=$1", [retailerId]);
    return Boolean(rows[0]?.baseline_completed);
  }
  async saveScan({ retailer, products, offers, observations, signals, completedAt, health }) {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of products) {
        await client.query(`INSERT INTO fatedrop_products (id,canonical_key,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at,first_seen_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, official_rrp_pence=COALESCE(EXCLUDED.official_rrp_pence,fatedrop_products.official_rrp_pence), rrp_source=COALESCE(EXCLUDED.rrp_source,fatedrop_products.rrp_source), rrp_observed_at=COALESCE(EXCLUDED.rrp_observed_at,fatedrop_products.rrp_observed_at), updated_at=EXCLUDED.updated_at`, [p.id,p.canonicalKey,p.title,p.productType,p.tcg,p.officialRrpPence,p.rrpSource,p.rrpObservedAt,p.firstSeenAt,p.updatedAt]);
        await client.query(`INSERT INTO fatedrop_product_identities (id,tcg,canonical_key,title,product_type,official_rrp_pence,rrp_source,rrp_verified_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tcg,canonical_key) DO UPDATE SET title=EXCLUDED.title, product_type=COALESCE(EXCLUDED.product_type,fatedrop_product_identities.product_type), official_rrp_pence=COALESCE(EXCLUDED.official_rrp_pence,fatedrop_product_identities.official_rrp_pence), rrp_source=COALESCE(EXCLUDED.rrp_source,fatedrop_product_identities.rrp_source), rrp_verified_at=COALESCE(EXCLUDED.rrp_verified_at,fatedrop_product_identities.rrp_verified_at), updated_at=GREATEST(EXCLUDED.updated_at,fatedrop_product_identities.updated_at)`, [p.id,p.tcg,p.canonicalKey,p.title,p.productType,p.officialRrpPence,p.rrpSource,p.rrpObservedAt,p.updatedAt]);
      }
      for (const o of offers) await client.query(`INSERT INTO fatedrop_retail_offers (offer_id,product_id,retailer_id,retailer_name,retailer_sku,title,url,image_url,price_pence,postage_pence,gtin,stock_status,stock_confidence,stock_quantity,ever_available_at,first_seen_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (offer_id) DO UPDATE SET product_id=EXCLUDED.product_id,title=EXCLUDED.title,url=EXCLUDED.url,image_url=COALESCE(EXCLUDED.image_url,fatedrop_retail_offers.image_url),price_pence=EXCLUDED.price_pence,postage_pence=EXCLUDED.postage_pence,gtin=COALESCE(EXCLUDED.gtin,fatedrop_retail_offers.gtin),stock_status=EXCLUDED.stock_status,stock_confidence=EXCLUDED.stock_confidence,stock_quantity=EXCLUDED.stock_quantity,ever_available_at=COALESCE(fatedrop_retail_offers.ever_available_at,EXCLUDED.ever_available_at),last_seen_at=EXCLUDED.last_seen_at`, [o.offerId,o.productId,o.retailerId,o.retailerName,o.retailerSku,o.title,o.url,o.imageUrl,o.pricePence,o.postagePence,o.gtin,o.stockStatus,o.stockConfidence,o.stockQuantity,o.everAvailableAt,o.firstSeenAt,o.lastSeenAt]);
      for (const x of observations) await client.query(`INSERT INTO fatedrop_stock_observations (id,offer_id,retailer_id,observed_at,stock_status,stock_confidence,stock_quantity,price_pence,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`, [x.id,x.offerId,x.retailerId,x.observedAt,x.stockStatus,x.stockConfidence,x.stockQuantity,x.pricePence,JSON.stringify(x.evidence)]);
      for (const s of signals) await client.query(`INSERT INTO fatedrop_signals (id,state,product_id,offer_id,retailer_id,retailer_name,title,product_type,url,image_url,price_pence,rrp_pence,postage_pence,delivered_price_pence,markup_percent,stock_status,previous_stock_status,confidence,detected_at,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb) ON CONFLICT DO NOTHING`, [s.id,s.state,s.productId,s.offerId,s.retailerId,s.retailerName,s.title,s.productType,s.url,s.imageUrl,s.pricePence,s.rrpPence,s.postagePence,s.deliveredPricePence,s.markupPercent,s.stockStatus,s.previousStockStatus,s.confidence,s.detectedAt,s.reason,JSON.stringify(s.evidence)]);
      await client.query(`INSERT INTO fatedrop_retailer_health (retailer_id,retailer_name,healthy,last_scan_at,last_success_at,last_error,last_error_at,products_seen,pages_scanned,baseline_completed) VALUES ($1,$2,true,$3,$3,NULL,NULL,$4,$5,true) ON CONFLICT (retailer_id) DO UPDATE SET retailer_name=EXCLUDED.retailer_name,healthy=true,last_scan_at=EXCLUDED.last_scan_at,last_success_at=EXCLUDED.last_success_at,last_error=NULL,products_seen=EXCLUDED.products_seen,pages_scanned=EXCLUDED.pages_scanned,baseline_completed=true`, [retailer.id,retailer.name,completedAt,health.productsSeen,health.pagesScanned]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async recordFailure(retailer, error, now) {
    const pool = await this.pool();
    await pool.query(`INSERT INTO fatedrop_retailer_health (retailer_id,retailer_name,healthy,last_scan_at,last_error,last_error_at) VALUES ($1,$2,false,$3,$4,$3) ON CONFLICT (retailer_id) DO UPDATE SET healthy=false,last_scan_at=EXCLUDED.last_scan_at,last_error=EXCLUDED.last_error,last_error_at=EXCLUDED.last_error_at`, [retailer.id,retailer.name,now,String(error?.message || error)]);
  }
  async listSignals({ states = [], retailerIds = [], since = 0, limit = 100 } = {}) {
    const pool = await this.pool();
    const values = [since, Math.min(250, limit)];
    const conditions = ["detected_at >= $1"];
    if (states.length) { values.push(states); conditions.push(`state = ANY($${values.length})`); }
    if (retailerIds.length) { values.push(retailerIds); conditions.push(`retailer_id = ANY($${values.length})`); }
    const { rows } = await pool.query(`SELECT * FROM fatedrop_signals WHERE ${conditions.join(" AND ")} ORDER BY detected_at DESC LIMIT $2`, values);
    return rows.map(dbSignal);
  }
  async listRetailers() { const pool=await this.pool(); const {rows}=await pool.query("SELECT * FROM fatedrop_retailer_health ORDER BY retailer_name"); return rows.map((r)=>({ id:r.retailer_id,name:r.retailer_name,healthy:r.healthy,lastScanAt:Number(r.last_scan_at||0)||null,lastSuccessAt:Number(r.last_success_at||0)||null,lastError:r.last_error,productsSeen:r.products_seen,pagesScanned:r.pages_scanned,baselineCompleted:r.baseline_completed })); }
  async recordNetworkSnapshot(snapshot) { const pool=await this.pool(); await pool.query(`INSERT INTO fatedrop_signal_network_snapshots (id, measured_at, metrics, retailer_health) VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT DO NOTHING`, [snapshot.id,snapshot.measuredAt,JSON.stringify(snapshot.metrics),JSON.stringify(snapshot.retailers)]); }
  async listNetworkSnapshots(limit=30) { const pool=await this.pool(); const safe=Math.min(180,Math.max(1,limit)); const {rows}=await pool.query(`SELECT * FROM fatedrop_signal_network_snapshots ORDER BY measured_at DESC LIMIT $1`,[safe]); return rows.map((r)=>({id:r.id,measuredAt:Number(r.measured_at),metrics:r.metrics,retailers:r.retailer_health})); }
  async stats() { const pool=await this.pool(); const {rows}=await pool.query(`SELECT (SELECT count(*) FROM fatedrop_products)::int products_tracked,(SELECT count(*) FROM fatedrop_retail_offers)::int offers_tracked,(SELECT count(*) FROM fatedrop_retail_offers WHERE stock_status IN ('in_stock','low_stock'))::int currently_available,(SELECT count(*) FROM fatedrop_signals WHERE detected_at >= extract(epoch from now())::bigint-86400)::int signals_24h,(SELECT count(*) FROM fatedrop_signals WHERE state='manifested' AND detected_at >= extract(epoch from now())::bigint-86400)::int manifested_24h,(SELECT count(*) FROM fatedrop_signals WHERE state='echo' AND detected_at >= extract(epoch from now())::bigint-86400)::int echo_24h,(SELECT count(*) FROM fatedrop_signals WHERE state='vanished' AND detected_at >= extract(epoch from now())::bigint-86400)::int vanished_24h,(SELECT count(*) FROM fatedrop_signals WHERE state='whisper' AND detected_at >= extract(epoch from now())::bigint-86400)::int whisper_24h`); const r=rows[0]; return {productsTracked:r.products_tracked,offersTracked:r.offers_tracked,currentlyAvailable:r.currently_available,signals24h:r.signals_24h,manifested24h:r.manifested_24h,echo24h:r.echo_24h,vanished24h:r.vanished_24h,whisper24h:r.whisper_24h}; }
}
function dbOffer(r){return{offerId:r.offer_id,productId:r.product_id,retailerId:r.retailer_id,retailerName:r.retailer_name,retailerSku:r.retailer_sku,title:r.title,url:r.url,imageUrl:r.image_url,pricePence:r.price_pence,postagePence:r.postage_pence,gtin:r.gtin||null,stockStatus:r.stock_status,stockConfidence:Number(r.stock_confidence),stockQuantity:r.stock_quantity,everAvailableAt:r.ever_available_at?Number(r.ever_available_at):null,firstSeenAt:Number(r.first_seen_at),lastSeenAt:Number(r.last_seen_at)}}
function dbProduct(r){return{id:r.id,canonicalKey:r.canonical_key,title:r.title,productType:r.product_type,tcg:r.tcg,officialRrpPence:r.official_rrp_pence,rrpSource:r.rrp_source,rrpObservedAt:r.rrp_observed_at?Number(r.rrp_observed_at):null,firstSeenAt:Number(r.first_seen_at),updatedAt:Number(r.updated_at)}}
function dbSignal(r){return{id:r.id,state:r.state,productId:r.product_id,offerId:r.offer_id,retailerId:r.retailer_id,retailerName:r.retailer_name,title:r.title,productType:r.product_type,url:r.url,imageUrl:r.image_url,pricePence:r.price_pence,rrpPence:r.rrp_pence,postagePence:r.postage_pence,deliveredPricePence:r.delivered_price_pence,markupPercent:r.markup_percent==null?null:Number(r.markup_percent),stockStatus:r.stock_status,previousStockStatus:r.previous_stock_status,confidence:Number(r.confidence),detectedAt:Number(r.detected_at),reason:r.reason,evidence:r.evidence||[]}}
