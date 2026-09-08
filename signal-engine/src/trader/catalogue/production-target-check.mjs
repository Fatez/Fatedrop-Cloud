import { pathToFileURL } from 'node:url';

const productionHosts = new Set([
  'ep-wild-lake-ax1q3qxf.c-4.us-east-2.aws.neon.tech',
  'ep-wild-lake-ax1q3qxf-pooler.c-4.us-east-2.aws.neon.tech',
]);

// This endpoint belongs to FateDrop production: summer-truth-31037285,
// branch br-empty-bar-axch9b61. Never accept arbitrary Neon endpoints.
export function validateProductionTarget(value) {
  if (!value) throw new Error('Configure the FATEPRICE_PRODUCTION_DATABASE_URL Actions secret before running this workflow.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Production database credential is malformed.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !productionHosts.has(url.hostname)
    || url.pathname !== '/neondb'
    || (url.port && url.port !== '5432')
    || !url.username || !url.password
    || [...url.searchParams.keys()].some(key => !['sslmode', 'channel_binding'].includes(key))
    || url.searchParams.getAll('sslmode').length !== 1
    || !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) {
    throw new Error('Production database target or TLS settings do not match the approved FateDrop database.');
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateProductionTarget(process.env.DATABASE_URL);
    // GitHub already masks its secret. Mask the password separately as well.
    const url = new URL(process.env.DATABASE_URL);
    const escape = (value) => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::add-mask::${escape(process.env.DATABASE_URL)}`);
    console.log(`::add-mask::${escape(decodeURIComponent(url.password))}`);
    console.log('Approved production database target; credential available.');
  } catch {
    console.error('Production credential preflight failed. Configure FATEPRICE_PRODUCTION_DATABASE_URL for the approved FateDrop production database with TLS. No catalogue work was started.');
    process.exitCode = 1;
  }
}
