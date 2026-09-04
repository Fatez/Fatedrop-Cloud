import fs from 'node:fs';

import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { rankCardmarketExpansionEvidence } from './cardmarket-mapping-audit.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function positiveInt(value, fallback, max = 50) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new TypeError(`Expected integer between 1 and ${max}, received ${value}`);
  }
  return parsed;
}

function readCardAudit(path) {
  if (!path) throw new TypeError('--cards-file=... is required');
  const report = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(report?.identities) || report.identities.length === 0) {
    throw new TypeError('cards file must contain non-empty identities[]');
  }
  if (!report?.set?.canonicalSetId || !report?.set?.setName) {
    throw new TypeError('cards file must contain set canonical identity');
  }
  return report;
}

async function main() {
  const cardsFile = argValue('cards-file');
  const limit = positiveInt(argValue('limit'), 10, 50);
  const cardAudit = readCardAudit(cardsFile);
  const expectedSourceSetCode = cardAudit.set.pokemonTcgSetCode ?? argValue('source-set-code') ?? null;
  const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
  const candidates = rankCardmarketExpansionEvidence(products, cardAudit.identities, {
    limit,
    expectedSourceSetCode,
  });

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'evidence_only',
    approved: false,
    writesPerformed: false,
    set: {
      canonicalSetId: cardAudit.set.canonicalSetId,
      setName: cardAudit.set.setName,
      seriesName: cardAudit.set.seriesName ?? null,
      tcgdexSetId: cardAudit.set.tcgdexSetId ?? null,
      pokemonTcgSetId: cardAudit.set.pokemonTcgSetId ?? null,
      pokemonTcgSetCode: cardAudit.set.pokemonTcgSetCode ?? null,
      expectedCardmarketSetCode: expectedSourceSetCode,
      verifiedIdentityRows: cardAudit.verification?.verifiedIdentityRows ?? cardAudit.identities.length,
    },
    cardmarketSource: {
      url: artifact.url,
      fetchedAt: artifact.fetchedAt,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      etag: artifact.etag,
      lastModified: artifact.lastModified,
      catalogueProducts: products.length,
    },
    candidates,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
