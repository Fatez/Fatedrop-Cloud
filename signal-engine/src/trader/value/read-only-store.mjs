function sqlText(query) {
  if (typeof query === 'string') return query;
  if (query && typeof query.text === 'string') return query.text;
  throw new TypeError('read-only store query must provide SQL text');
}

function stripLeadingSqlComments(value) {
  let text = String(value || '').trimStart();
  while (text.startsWith('--') || text.startsWith('/*')) {
    if (text.startsWith('--')) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1).trimStart();
      continue;
    }
    const end = text.indexOf('*/', 2);
    if (end === -1) throw new TypeError('unterminated SQL comment');
    text = text.slice(end + 2).trimStart();
  }
  return text;
}

function assertReadOnlySql(query) {
  const text = stripLeadingSqlComments(sqlText(query));
  const keyword = text.match(/^([a-z]+)/i)?.[1]?.toUpperCase() ?? '';
  if (!['SELECT', 'SHOW', 'EXPLAIN'].includes(keyword)) {
    throw new Error(`Fate Value rehearsal blocked non-read SQL statement: ${keyword || 'unknown'}`);
  }
  return query;
}

function readOnlyPool(pool) {
  return Object.freeze({
    query(query, values) {
      assertReadOnlySql(query);
      return pool.query(query, values);
    },
  });
}

export function createReadOnlyStoreView(store) {
  if (!store || typeof store !== 'object') throw new TypeError('canonical store is required');

  if (typeof store.read === 'function') {
    return Object.freeze({
      read: store.read.bind(store),
    });
  }

  if (typeof store.pool === 'function') {
    let poolPromise = null;
    return Object.freeze({
      async pool() {
        if (!poolPromise) poolPromise = store.pool().then(readOnlyPool);
        return poolPromise;
      },
    });
  }

  throw new Error('canonical store does not expose a supported read capability');
}

export function assertFateValueReadOnlySqlForTest(query) {
  return assertReadOnlySql(query);
}
