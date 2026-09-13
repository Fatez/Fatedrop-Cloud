import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { compileJapaneseCatalogueAcquisition } from './japanese-catalogue-evidence.mjs';

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function timestamp(value = Date.now()) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  const inputPath = resolve(arg('input') || 'japanese-catalogue-acquisition.json');
  const outputPath = resolve(arg('output') || 'japanese-catalogue-artifact.json');
  const auditPath = resolve(arg('audit') || `japanese_evidence_audit_${timestamp()}.json`);
  const reviewReference = arg('review-reference') || process.env.JAPANESE_REVIEW_REFERENCE || process.env.GITHUB_SHA;
  const verifiedAt = Date.now();
  let audit;
  try {
    const acquisition = JSON.parse(await readFile(inputPath, 'utf8'));
    const artifact = compileJapaneseCatalogueAcquisition(acquisition, { verifiedAt, reviewReference });
    await writeFile(outputPath, JSON.stringify(artifact));
    audit = { status: 'complete', runId: artifact.runId, generatedAt: artifact.generatedAt, reviewReference: artifact.reviewReference, productionWrites: false, ...artifact.audit, counts: artifact.counts, artifact: basename(outputPath) };
    await writeFile(auditPath, JSON.stringify(audit, null, 2));
    console.log(JSON.stringify(audit, null, 2));
  } catch (error) {
    audit = { status: 'blocked', generatedAt: new Date(verifiedAt).toISOString(), productionWrites: false, input: basename(inputPath), error: error instanceof Error ? error.message : String(error), rejectedSets: error?.rejectedSets || [], stack: error instanceof Error ? error.stack : null };
    await writeFile(auditPath, JSON.stringify(audit, null, 2));
    console.error(JSON.stringify(audit, null, 2));
    process.exitCode = 1;
  }
}

await main();
