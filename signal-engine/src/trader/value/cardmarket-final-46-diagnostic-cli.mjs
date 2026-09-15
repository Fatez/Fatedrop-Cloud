import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-final-46-user-urls-2026-09-15.json');

function compact(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[♀♂]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function targetNameMatches(target, product) {
  const parsed = parseCardmarketSingleProductName(product.name);
  const productName = parsed?.cardName ?? product.name;
  return rootProductNameMatches(target.name, productName)
    || compact(productName) === compact(target.name)
    || compact(product.name).startsWith(compact(target.name));
}

async function main() {
  const manifest = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    const setNames = [...new Set(manifest.entries.map((row) => row.setName))];
    const { rows: mappings } = await db.query(`
      SELECT s.name AS set_name,m.source_record_id
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      WHERE m.source_name='cardmarket' AND s.name=ANY($1::text[])`, [setNames]);

    const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
    const expansionCounts = new Map();
    for (const row of mappings) {
      const product = productById.get(String(row.source_record_id));
      if (!product) continue;
      const byId = expansionCounts.get(row.set_name) || new Map();
      const expansionId = Number(product.sourceExpansionId);
      if (Number.isSafeInteger(expansionId)) byId.set(expansionId, (byId.get(expansionId) || 0) + 1);
      expansionCounts.set(row.set_name, byId);
    }

    const report = [];
    for (const entry of manifest.entries) {
      const counts = [...(expansionCounts.get(entry.setName) || new Map()).entries()]
        .sort((a,b) => b[1]-a[1] || a[0]-b[0]);
      const leadingExpansionIds = counts.length ? new Set(counts.filter(([,count]) => count === counts[0][1] || count >= 2).map(([id]) => id)) : null;
      const scoped = leadingExpansionIds
        ? products.filter((product) => leadingExpansionIds.has(Number(product.sourceExpansionId)))
        : products;
      const matches = scoped.filter((product) => targetNameMatches(entry, product)).slice(0, 25);
      const fallbackMatches = matches.length || !leadingExpansionIds
        ? []
        : products.filter((product) => targetNameMatches(entry, product)).slice(0, 25);
      report.push({
        setName: entry.setName,
        name: entry.name,
        collectorNumber: entry.collectorNumber,
        url: entry.url,
        leadingExpansionIds: counts.slice(0, 8),
        scopedMatches: matches.map((product) => ({
          sourceRecordId: String(product.sourceRecordId),
          sourceExpansionId: product.sourceExpansionId,
          name: product.name,
          parsed: parseCardmarketSingleProductName(product.name),
          raw: product,
        })),
        fallbackMatches: fallbackMatches.map((product) => ({
          sourceRecordId: String(product.sourceRecordId),
          sourceExpansionId: product.sourceExpansionId,
          name: product.name,
          parsed: parseCardmarketSingleProductName(product.name),
          raw: product,
        })),
      });
    }

    console.log(JSON.stringify({ catalogueSha256: artifact.sha256, products: products.length, report }, null, 2));
  } finally {
    db.release();
    await pool.end();
  }
}

await main();
