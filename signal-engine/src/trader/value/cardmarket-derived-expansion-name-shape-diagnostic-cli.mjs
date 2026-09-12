import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';

const MIN_PROVEN_PRODUCTS = 5;
const key = (...parts) => parts.join('|');

function stripProviderDescriptors(name) {
  let value = String(name || '').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const suffix = /\s+\[[^[\]]+\]\s*$/;
  while (suffix.test(value)) value = value.replace(suffix, '').trim();
  return value;
}

function norm(value) { return normaliseComparableName(String(value || '')); }
function base(value) { return norm(stripProviderDescriptors(value)); }
function expansionId(product) {
  const n = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true') throw new Error('Diagnostic is read-only');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
    const productById = new Map(products.map((p) => [String(p.sourceRecordId), p]));
    const productsByExpansion = new Map();
    for (const p of products) {
      const eid = expansionId(p);
      if (!eid) continue;
      const rows = productsByExpansion.get(eid) || [];
      rows.push(p);
      productsByExpansion.set(eid, rows);
    }

    const { rows: mappings } = await db.query(`
      SELECT m.card_identity_id,m.source_record_id,i.set_id
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      WHERE m.source_name='cardmarket' AND m.source_variant_key IN ('normal','holo')
        AND i.verification_status='verified' AND i.language_code='en'`);
    const mappedIds = new Set(mappings.map((r) => r.card_identity_id));
    const mappedProductsBySet = new Map();
    for (const row of mappings) {
      const ids = mappedProductsBySet.get(row.set_id) || new Set();
      ids.add(String(row.source_record_id));
      mappedProductsBySet.set(row.set_id, ids);
    }
    const provenExpansionBySet = new Map();
    const setEvidence = [];
    for (const [setId, sourceIds] of mappedProductsBySet) {
      const resolved = [...sourceIds].map((id) => productById.get(id));
      const eids = new Set(resolved.map(expansionId).filter(Boolean));
      if (sourceIds.size >= MIN_PROVEN_PRODUCTS && resolved.every(Boolean) && eids.size === 1) {
        const eid = [...eids][0];
        provenExpansionBySet.set(setId, eid);
        setEvidence.push({ setId, sourceExpansionId: eid, existingMappedProducts: sourceIds.size });
      }
    }

    const { rows: identities } = await db.query(`
      SELECT i.id,i.printing_id,i.variant_code,i.set_id,p.name,p.collector_number,s.name set_name
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      WHERE i.verification_status='verified' AND i.language_code='en'
        AND i.variant_code IN ('standard','holo') AND s.verification_status='verified'`);

    const printingsBySetName = new Map();
    for (const row of identities) {
      const n = norm(row.name);
      const k = key(row.set_id, n);
      const ids = printingsBySetName.get(k) || new Set();
      ids.add(row.printing_id);
      printingsBySetName.set(k, ids);
    }

    const zeroSamples = [], multiSamples = [];
    const counts = { eligibleUniqueCanonicalInProvenExpansion: 0, exactUnique: 0, exactMultiple: 0, exactZero: 0 };
    for (const row of identities) {
      if (mappedIds.has(row.id)) continue;
      const eid = provenExpansionBySet.get(row.set_id);
      if (!eid) continue;
      const canonical = norm(row.name);
      const printingIds = printingsBySetName.get(key(row.set_id, canonical)) || new Set();
      if (!canonical || printingIds.size !== 1) continue;
      counts.eligibleUniqueCanonicalInProvenExpansion++;
      const expansionProducts = productsByExpansion.get(eid) || [];
      const exact = expansionProducts.filter((p) => base(p.name) === canonical);
      if (exact.length === 1) { counts.exactUnique++; continue; }
      if (exact.length > 1) {
        counts.exactMultiple++;
        if (multiSamples.length < 150) multiSamples.push({
          setName: row.set_name, setId: row.set_id, sourceExpansionId: eid,
          canonicalName: row.name, collectorNumber: row.collector_number, variantCode: row.variant_code,
          matches: exact.slice(0, 12).map((p) => ({ sourceRecordId: String(p.sourceRecordId), productName: p.name, baseName: stripProviderDescriptors(p.name) })),
        });
        continue;
      }
      counts.exactZero++;
      if (zeroSamples.length < 250) {
        const related = expansionProducts
          .map((p) => ({ p, b: base(p.name) }))
          .filter(({ b }) => b)
          .map(({ p, b }) => ({
            sourceRecordId: String(p.sourceRecordId), productName: p.name, baseName: stripProviderDescriptors(p.name), normalizedBase: b,
            distance: levenshtein(canonical, b),
            contains: b.includes(canonical) || canonical.includes(b),
            sameFirstToken: canonical.split(' ')[0] === b.split(' ')[0],
          }))
          .filter((x) => x.contains || x.sameFirstToken || x.distance <= Math.max(2, Math.floor(canonical.length * 0.25)))
          .sort((a, b) => Number(b.contains) - Number(a.contains) || a.distance - b.distance || a.productName.localeCompare(b.productName))
          .slice(0, 6);
        zeroSamples.push({
          setName: row.set_name, setId: row.set_id, sourceExpansionId: eid,
          canonicalName: row.name, normalizedCanonical: canonical, collectorNumber: row.collector_number, variantCode: row.variant_code,
          related,
        });
      }
    }

    report = { status:'complete', productionWrites:false, source:{ cardmarketCatalogueSha256:artifact.sha256 }, counts, setEvidence, multiSamples, zeroSamples };
  } catch (error) {
    report = { status:'blocked', productionWrites:false, error:error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release(); await pool.end();
    const file = `${process.env.RUNNER_TEMP || '.'}/cardmarket-derived-expansion-name-shape-diagnostic.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status:report.status, counts:report.counts, multiSamples:report.multiSamples?.slice(0,10), zeroSamples:report.zeroSamples?.slice(0,10) }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
