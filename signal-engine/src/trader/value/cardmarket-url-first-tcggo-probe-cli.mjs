import { writeFile } from 'node:fs/promises';

const SAMPLE = Object.freeze([
  { tcgId: 'xy7-10', cardmarketId: '295200' },
  { tcgId: 'pl4-94', cardmarketId: '278966' },
  { tcgId: 'pl4-AR2', cardmarketId: '278864' },
  { tcgId: 'pl4-AR3', cardmarketId: '278863' },
  { tcgId: 'pl4-AR7', cardmarketId: '278866' },
  { tcgId: 'xy9-107a', cardmarketId: '297896' },
]);

function extractCardmarketIds(html) {
  const ids = new Set();
  for (const re of [
    /"cardmarket_id"\s*:\s*(\d+)/gi,
    /\bCM\s+(\d{5,})\b/gi,
    /cardmarket[^\d]{0,40}(\d{5,})/gi,
  ]) {
    for (const match of html.matchAll(re)) ids.add(match[1]);
  }
  return [...ids];
}

async function fetchExactTcgId(tcgId) {
  const url = new URL('https://www.tcggo.com/api-playground');
  url.searchParams.set('ep', 'cards.search');
  url.searchParams.set('game', 'pokemon');
  url.searchParams.set('q[tcgid]', tcgId);
  url.searchParams.set('q[sort]', 'relevance');
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'FateDrop-Cardmarket-Rebuild-Audit/1.0',
    },
    redirect: 'follow',
  });
  const html = await response.text();
  return {
    tcgId,
    status: response.status,
    ok: response.ok,
    bytes: Buffer.byteLength(html),
    hasTcgId: html.toLowerCase().includes(tcgId.toLowerCase()),
    cardmarketIds: extractCardmarketIds(html),
    containsExpectedJsonKey: /"cardmarket_id"\s*:/.test(html),
  };
}

const rows = [];
for (const sample of SAMPLE) {
  try {
    const result = await fetchExactTcgId(sample.tcgId);
    rows.push({
      ...sample,
      ...result,
      expectedSeen: result.cardmarketIds.includes(sample.cardmarketId),
    });
  } catch (error) {
    rows.push({ ...sample, status: 'error', error: error instanceof Error ? error.message : String(error), expectedSeen: false });
  }
}

const report = {
  status: rows.every((row) => row.expectedSeen) ? 'passed' : 'incomplete',
  productionWrites: false,
  rows,
};
const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-url-first-tcggo-probe.json`;
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 2;
