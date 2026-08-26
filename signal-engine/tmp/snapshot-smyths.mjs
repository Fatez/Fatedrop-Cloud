import fs from 'node:fs/promises';

const STORE_NAMES = [
  'Biggleswade','Chelmsford','Colchester','Harlow','Ipswich','Luton','Norwich','Peterborough','Rayleigh Weir','Stevenage',
  'Ashford','Aylesbury Broadfields','Basingstoke','Crawley','Eastbourne','Farnborough','Gillingham','Hedge End','Maidstone','Milton Keynes','Portsmouth','Reading','Slough','Southampton','Staines','Thanet',
  'Barrow-in-Furness','Blackburn','Blackpool','Bolton','Bromborough','Bury','Carlisle','Liverpool Croxteth','Liverpool Edge Lane','Liverpool Speke','Oldham','Preston','Salford','St. Helens','Stockport','Warrington','Wigan',
  'Cardiff East','Cardiff Leckwith','Llandudno','Llanelli','Newport','Swansea','Wrexham',
  'Beckton','Charlton','Colliers Wood','Crayford','Croydon','Enfield','Friern Barnet','Greenford','Loughton','Old Kent Road','Romford','Staples Corner / Brent Cross','Thurrock','Uxbridge','Watford',
  'Barnsley','Bradford','Doncaster','Grimsby','Hull','Leeds Birstall','Leeds Crown Point','Leeds Kirkstall','Rotherham','Sheffield Drakehouse','Sheffield Meadowhall','Wakefield','York Monks Cross',
  'Darlington','Durham','Metro Centre','Stockton-on-Tees','Sunderland','Team Valley','Wallsend',
  'Aberdeen','Clydebank','Dundee','Edinburgh','Falkirk','Glasgow','Inverness','Kilmarnock','Linwood Paisley','Livingston',
  'Castlevale','Coventry Airport Park','Coventry Arena Park','Kidderminster','Longbridge','Longton','Merry Hill','Oldbury','Solihull','Tamworth','Telford','Walsall','Wolverhampton',
  'Ballymena','Bangor (NI)','Boucher Road','Derry/Londonderry','Forestside','Newry','Newtownabbey',
  'Chesterfield','Derby','Leicester','Lincoln','Mansfield','Northampton','Nottingham',
  'Bournemouth','Bristol Avonmeads','Bristol Cribbs Causeway','Bristol Longwell Green','Cheltenham','Exeter','Gloucester','Plymouth','Poole','Swindon','Weston-super-Mare',
];

const BASE = 'https://www.smythstoys.com/uk/en-gb/storefinder/storedetails';
const STORE_FINDER = 'https://www.smythstoys.com/uk/en-gb/storefinder';
const USER_AGENT = 'FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (value) => value
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' and ')
  .replace(/[().]/g, ' ').replace(/[\/]+/g, ' ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const overrides = new Map([
  ['Staples Corner / Brent Cross','staples-corner-brent-cross'],
  ['Bangor (NI)','bangor-ni'],
  ['Derry/Londonderry','derry-londonderry'],
]);

function normalizePostcode(value) {
  const compact = String(value || '').toUpperCase().replace(/\s+/g, '');
  return compact.length >= 5 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : null;
}

async function geocodeBranch(branchName) {
  const q = `Smyths Toys ${branchName}, United Kingdom`;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '3');
  url.searchParams.set('countrycodes', 'gb');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept:'application/json', 'user-agent':USER_AGENT },
    });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    const results = await response.json();
    const candidates = Array.isArray(results) ? results : [];
    const best = candidates.find((row) => /smyths/i.test(String(row?.display_name || ''))) || null;
    if (!best) return null;
    const latitude = Number(best.lat);
    const longitude = Number(best.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const postcode = normalizePostcode(best.address?.postcode);
    return {
      latitude,
      longitude,
      postcode,
      address: String(best.display_name || '').trim() || null,
      geocodeProvider: 'nominatim_openstreetmap_snapshot',
      geocodeOsmType: best.osm_type || null,
      geocodeOsmId: best.osm_id || null,
      geocodeDisplayName: best.display_name || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const observedAt = new Date().toISOString();
const rows = [];
for (const branchName of STORE_NAMES) {
  const pageSlug = overrides.get(branchName) || slug(branchName);
  const website = `${BASE}/${pageSlug}`;
  let geo = null;
  let error = null;
  try {
    geo = await geocodeBranch(branchName);
  } catch (err) {
    error = String(err?.message || err);
  }
  rows.push({
    retailerId:'smyths-uk',
    name:`Smyths Toys — ${branchName}`,
    branchName,
    provider:'smyths_curated_snapshot',
    providerId:pageSlug,
    website,
    verification:'curated_official_branch',
    sourceUrl:website,
    ...(geo || {}),
    ...(error ? { error } : {}),
    openingDetails:{
      sourceType:'official_retailer_directory_snapshot',
      sourceUrl:website,
      sourceDirectoryUrl:STORE_FINDER,
      sourceAttribution:'Smyths Toys official store finder; coordinates one-time geocoded from branch identity',
      sourceObservedAt:observedAt,
      ...(geo?.geocodeProvider ? { geocodeProvider:geo.geocodeProvider } : {}),
      ...(geo?.geocodeOsmType ? { geocodeOsmType:geo.geocodeOsmType } : {}),
      ...(geo?.geocodeOsmId ? { geocodeOsmId:geo.geocodeOsmId } : {}),
      ...(geo?.geocodeDisplayName ? { geocodeDisplayName:geo.geocodeDisplayName } : {}),
    },
  });
  await sleep(1100);
}

const usable = rows.filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
const rejected = rows.filter((row) => !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude));
const summary = {
  generatedAt:observedAt,
  retailerId:'smyths-uk',
  sourceUrl:STORE_FINDER,
  sourceType:'official_retailer_directory_snapshot',
  total:rows.length,
  withPostcode:rows.filter((r)=>r.postcode).length,
  withCoordinates:usable.length,
  unresolved:rejected.map((r)=>({branchName:r.branchName,error:r.error || 'no trustworthy Smyths geocode match',website:r.website})),
  rows,
};
await fs.writeFile('tmp/smyths-branches.generated.json', JSON.stringify(summary,null,2)+'\n');
console.log('SMYTHS_SNAPSHOT_SUMMARY', JSON.stringify({total:summary.total,withPostcode:summary.withPostcode,withCoordinates:summary.withCoordinates,unresolved:summary.unresolved.length}));
console.log('SMYTHS_SNAPSHOT_UNRESOLVED', JSON.stringify(summary.unresolved));
