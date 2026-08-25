import { createHash } from 'node:crypto';

export function bearerTokenFromNodeRequest(req) {
  const authorization = String(req?.headers?.authorization || '');
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || null;
}

export function hashFateDropSessionToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export async function resolveFateTraderSessionUser(store, req, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const token = bearerTokenFromNodeRequest(req);
  if (!token) return null;
  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const tokenHash = hashFateDropSessionToken(token);
  const { rows } = await pool.query(`SELECT u.id,u.fate_id,u.username,u.display_name
    FROM fatedrop_sessions s
    JOIN fatedrop_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>$2
    LIMIT 1`, [tokenHash, nowSeconds]);
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    fateId: rows[0].fate_id,
    username: rows[0].username,
    displayName: rows[0].display_name,
  };
}
