import { COB_PIP_EXACT_CARD_CONNECTOR } from './cob-pip-exact-card-offers.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateConnector(connector) {
  const id = text(connector?.id);
  if (!id) throw new TypeError('Retail-single connector id is required');
  if (text(connector?.retailer?.id) !== id) {
    throw new TypeError(`Retail-single connector ${id} must use its canonical retailer id`);
  }
  if (!text(connector?.retailer?.name)) throw new TypeError(`Retail-single connector ${id} retailer name is required`);
  if (typeof connector?.runCycle !== 'function') throw new TypeError(`Retail-single connector ${id} runCycle is required`);
  return Object.freeze(connector);
}

export function createRetailSingleConnectorRegistry(connectors = []) {
  const byId = new Map();
  for (const candidate of connectors) {
    const connector = validateConnector(candidate);
    if (byId.has(connector.id)) throw new TypeError(`Duplicate retail-single connector id: ${connector.id}`);
    byId.set(connector.id, connector);
  }
  return Object.freeze({
    list() {
      return Object.freeze([...byId.values()]);
    },
    require(id) {
      const key = text(id);
      const connector = byId.get(key);
      if (!connector) throw new TypeError(`Unknown retail-single connector: ${key || '(empty)'}`);
      return connector;
    },
  });
}

export const retailSingleConnectorRegistry = createRetailSingleConnectorRegistry([
  COB_PIP_EXACT_CARD_CONNECTOR,
]);

async function runBounded(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index]);
    }
  }
  const count = Math.max(1, Math.min(items.length || 1, concurrency));
  await Promise.all(Array.from({ length: count }, () => consume()));
  return output;
}

/**
 * Run every selected exact-card retailer connector through the same canonical
 * offer boundary. One retailer failure is isolated, while a bounded worker pool
 * prevents concurrent write pressure from overwhelming production Postgres.
 */
export async function runRetailSingleNetworkCycle({
  store,
  registry = retailSingleConnectorRegistry,
  retailerIds = null,
  collectionKeysByRetailer = {},
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  write = false,
  concurrency = 2,
} = {}) {
  if (!store) throw new TypeError('store is required');
  const selected = Array.isArray(retailerIds) && retailerIds.length
    ? [...new Set(retailerIds.map(text).filter(Boolean))].map((id) => registry.require(id))
    : registry.list();
  const safeConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(concurrency)) || 1));
  const connectors = await runBounded(selected, safeConcurrency, async (connector) => {
    try {
      const result = await connector.runCycle({
        store,
        collectionKeys: collectionKeysByRetailer?.[connector.id] || null,
        fetchImpl,
        now,
        write,
      });
      return Object.freeze({ id: connector.id, status: 'completed', result });
    } catch (error) {
      return Object.freeze({
        id: connector.id,
        status: 'failed',
        error: Object.freeze({
          name: text(error?.name) || 'Error',
          message: text(error?.message) || 'Retail-single connector failed',
          code: text(error?.code) || null,
        }),
      });
    }
  });
  const completed = connectors.filter((item) => item.status === 'completed');
  const failed = connectors.filter((item) => item.status === 'failed');
  return Object.freeze({
    mode: write ? 'write' : 'dry-run',
    status: failed.length ? (completed.length ? 'partial' : 'failed') : 'completed',
    generatedAt: new Date(now).toISOString(),
    connectorCount: connectors.length,
    completedCount: completed.length,
    failedCount: failed.length,
    totals: Object.freeze({
      candidates: completed.reduce((sum, item) => sum + Number(item.result?.candidates || 0), 0),
      verified: completed.reduce((sum, item) => sum + Number(item.result?.verified || 0), 0),
      buyableVerified: completed.reduce((sum, item) => sum + Number(item.result?.buyableVerified || 0), 0),
      quarantined: completed.reduce((sum, item) => sum + Number(item.result?.quarantined || 0), 0),
    }),
    connectors: Object.freeze(connectors),
  });
}

export const __test = Object.freeze({ runBounded, validateConnector });
