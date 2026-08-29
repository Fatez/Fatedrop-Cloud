function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicStage(kind) {
  return String(kind || '').toLowerCase() === 'echo' ? 'ECHO' : 'WHISPER';
}

function classifyProductTitle(title) {
  const normalized = String(title || '').toLowerCase().replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  if (/elite trainer box|\betbs?\b|booster (?:box|display|bundle|pack)|sleeved booster|blister|build\s*(?:&|and)\s*battle|trainer toolkit|battle deck|theme deck|league battle deck|starter deck|\btin\b/.test(normalized)) {
    return {
      category: 'SEALED_TCG',
      subcategory: /elite trainer box|\betbs?\b/.test(normalized) ? 'ETB' : 'SEALED_PRODUCT',
      confidence: 0.94,
      evidence: ['retailer-chain-advisory-title-classification'],
    };
  }
  return {
    category: 'UNKNOWN',
    subcategory: 'UNCLASSIFIED',
    confidence: 0.4,
    evidence: ['retailer-chain-advisory-unresolved-product'],
  };
}

function expectedPhrase(evidence) {
  return text(evidence.expectedLabel)
    || text(evidence.expected_label)
    || (text(evidence.expectedFrom) ? `Expected ${new Date(evidence.expectedFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' })}` : null)
    || 'Expected physical stock';
}

function canonicalAlertFromRow(row) {
  const evidence = evidenceObject(row.evidence_json);
  const stage = publicStage(row.kind);
  const state = stage.toLowerCase();
  const retailer = text(row.retailer_name) || text(row.retailer_id) || 'Retailer';
  const title = text(evidence.rawProductTitle ?? evidence.raw_product_title ?? evidence.productTitle ?? evidence.title) || 'Incoming physical stock';
  const sourceUrl = text(evidence.sourceUrl ?? evidence.source_url);
  const detectedAt = new Date(Number(row.occurred_at) * 1000).toISOString();
  const confidence = Math.max(0, Math.min(1, number(evidence.confidence) ?? (stage === 'ECHO' ? 0.62 : 0.48)));
  const productIntelligence = classifyProductTitle(title);
  const expectation = expectedPhrase(evidence);
  const message = `${expectation} at participating ${retailer} stores. Exact participating branches are still being resolved. Physical stock is not confirmed yet.`;
  const primary = sourceUrl ? {
    offerId: '',
    retailerId: text(row.retailer_id) || '',
    retailer,
    url: sourceUrl,
    itemPricePence: null,
    deliveredPricePence: null,
    stockStatus: 'expected',
    intent: 'inspect',
    label: 'VIEW SOURCE',
  } : null;

  return {
    id: String(row.id),
    type: stage,
    fateStage: stage,
    productId: null,
    offerId: null,
    retailerId: text(row.retailer_id),
    title,
    message,
    retailer,
    detectedAt,
    observedDurationSeconds: null,
    productIntelligence,
    confirmed: false,
    confirmedRestock: false,
    productUrl: sourceUrl,
    product: {
      title,
      productType: null,
      url: sourceUrl,
      imageUrl: null,
      pricePence: null,
      rrpPence: null,
      deliveredPricePence: null,
    },
    priceIntelligence: {
      rrpPence: null,
      rrpDeltaPercent: null,
      comparisonBasis: 'item',
      verdict: 'NO_FAIR_COMPARISON',
      currentComparisonPence: null,
      lowestKnown: null,
      savingsPence: null,
      savingsPercent: null,
    },
    signalThread: [{
      id: String(row.id),
      state,
      fateStage: stage,
      retailer,
      occurredAt: detectedAt,
      reason: message,
      pricePence: null,
      stockStatus: 'expected',
      previousStockStatus: null,
      url: sourceUrl || '',
    }],
    preparedLinks: {
      primary,
      lowestKnown: null,
      officialReference: null,
      alternatives: [],
      compareQuery: title,
      fateFindQuery: title,
    },
    notification: {
      title: `FateDrop · ${stage === 'ECHO' ? 'Echo' : 'Whisper'} · ${title}`,
      body: message,
      data: {
        route: 'alerts',
        alertId: String(row.id),
        productUrl: sourceUrl,
        stage,
        verdict: 'NO_FAIR_COMPARISON',
        lowestKnownUrl: null,
        compareQuery: title,
        productCategory: productIntelligence.category,
        observedDurationSeconds: null,
        linksPrepared: true,
      },
    },
    confidence,
    localRadar: {
      advisory: true,
      scope: 'retailer_chain',
      physicalStockConfirmed: false,
      branchResolved: false,
      expectedFrom: text(evidence.expectedFrom ?? evidence.expected_from),
      expectedTo: text(evidence.expectedTo ?? evidence.expected_to),
      expectedLabel: text(evidence.expectedLabel ?? evidence.expected_label),
      sourceType: text(evidence.sourceType ?? evidence.source_type),
      sourceLabel: text(evidence.sourceLabel ?? evidence.source_label),
    },
  };
}

export async function listCanonicalLocalRadarChainAlerts(store, { id = null, limit = 50 } = {}) {
  if (!store || typeof store.pool !== 'function') return [];
  const pool = await store.pool();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const { rows } = await pool.query(`
    SELECT
      se.id,
      se.kind,
      se.retailer_id,
      se.occurred_at,
      se.evidence_json,
      rr.retailer_name
    FROM fatedrop_signal_events se
    LEFT JOIN fatedrop_retailer_registry rr ON rr.retailer_id=se.retailer_id
    WHERE se.location_id IS NULL
      AND se.kind IN ('whisper','echo')
      AND COALESCE(se.evidence_json->>'localIntel','false')='true'
      AND se.evidence_json->>'scope'='retailer_chain'
      AND ($1::text IS NULL OR se.id=$1)
    ORDER BY se.occurred_at DESC
    LIMIT $2
  `, [id || null, safeLimit]);
  return rows.map(canonicalAlertFromRow);
}
