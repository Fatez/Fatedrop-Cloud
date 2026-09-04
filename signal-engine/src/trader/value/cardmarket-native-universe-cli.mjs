#!/usr/bin/env node

import {
  fetchCardmarketPokemonPriceGuide,
  fetchCardmarketPokemonSinglesCatalogue,
} from './cardmarket-source-client.mjs';
import { buildCardmarketNativeUniverseAudit } from './cardmarket-native-universe.mjs';

function artifactSummary(artifact) {
  return Object.freeze({
    url: artifact.url,
    fetchedAt: artifact.fetchedAt,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    etag: artifact.etag,
    lastModified: artifact.lastModified,
  });
}

async function main() {
  const fetchedAt = Date.now();
  const [catalogueResult, priceGuideResult] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue({ fetchedAt }),
    fetchCardmarketPokemonPriceGuide({ fetchedAt }),
  ]);

  const audit = buildCardmarketNativeUniverseAudit({
    products: catalogueResult.products,
    snapshot: priceGuideResult.snapshot,
  });

  const output = {
    mode: 'read-only-cardmarket-native-universe-audit',
    writesPerformed: false,
    generatedAt: new Date(fetchedAt).toISOString(),
    provenance: {
      catalogue: artifactSummary(catalogueResult.artifact),
      priceGuide: artifactSummary(priceGuideResult.artifact),
    },
    audit,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Cardmarket native universe audit failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
