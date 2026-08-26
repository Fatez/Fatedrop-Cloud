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
const headers = { accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'user-agent':'FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)' };
const postcodeRe = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const strip = (value='') => String(value)
  .replace(/<script[\s\S]*?<\/script>/gi,' ')
  .replace(/<style[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]+>/g,' ')
  .replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ')
  .replace(/\s+/g,' ').trim();

async function fetchText(url, timeoutMs=20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect:'follow', signal:controller.signal, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

const rows = new Array(STORE_NAMES.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= STORE_NAMES.length) return;
    const name = STORE_NAMES[index];
    const pageSlug = overrides.get(name) || slug(name);
    const website = `${BASE}/${pageSlug}`;
    try {
      const html = await fetchText(website);
      const text = strip(html);
      const postcodeRaw = text.match(postcodeRe)?.[1]?.toUpperCase().replace(/\s+/g,'') || null;
      const postcode = postcodeRaw ? `${postcodeRaw.slice(0,-3)} ${postcodeRaw.slice(-3)}` : null;
      rows[index] = { retailerId:'smyths-uk', name:`Smyths Toys — ${name}`, branchName:name, provider:'smyths_official_snapshot', providerId:pageSlug, postcode, website, verification:'official_retailer_branch', sourceUrl:website };
    } catch (error) {
      rows[index] = { retailerId:'smyths-uk', name:`Smyths Toys — ${name}`, branchName:name, provider:'smyths_official_snapshot', providerId:pageSlug, postcode:null, website, verification:'official_retailer_branch', sourceUrl:website, error:String(error?.message || error) };
    }
  }
}
await Promise.all(Array.from({ length:10 }, () => worker()));

const coordinates = new Map();
const postcodes = [...new Set(rows.map((r)=>r.postcode).filter(Boolean))];
for (let i=0;i<postcodes.length;i+=100) {
  const batch = postcodes.slice(i,i+100);
  const response = await fetch('https://api.postcodes.io/postcodes', {
    method:'POST', headers:{'content-type':'application/json','user-agent':'FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)'}, body:JSON.stringify({postcodes:batch}),
  });
  if (!response.ok) throw new Error(`postcodes.io HTTP ${response.status}`);
  const payload = await response.json();
  for (const item of payload?.result || []) {
    if (item?.query && item?.result?.latitude != null && item?.result?.longitude != null) {
      coordinates.set(String(item.query).toUpperCase(), { latitude:Number(item.result.latitude), longitude:Number(item.result.longitude) });
    }
  }
}

const enriched = rows.map((row) => ({ ...row, ...(coordinates.get(String(row.postcode || '').toUpperCase()) || {}), openingDetails:{ sourceType:'official_retailer_directory_snapshot', sourceUrl:row.sourceUrl, sourceAttribution:'Smyths Toys official store finder', sourceObservedAt:new Date().toISOString() } }));
const summary = {
  generatedAt:new Date().toISOString(), retailerId:'smyths-uk', sourceUrl:'https://www.smythstoys.com/uk/en-gb/storefinder', sourceType:'official_retailer_directory_snapshot',
  total:enriched.length, withPostcode:enriched.filter((r)=>r.postcode).length, withCoordinates:enriched.filter((r)=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)).length,
  errors:enriched.filter((r)=>r.error).map((r)=>({branchName:r.branchName,error:r.error,website:r.website})), rows:enriched,
};
await fs.writeFile('tmp/smyths-branches.generated.json', JSON.stringify(summary,null,2)+'\n');
console.log('SMYTHS_SNAPSHOT_SUMMARY', JSON.stringify({total:summary.total,withPostcode:summary.withPostcode,withCoordinates:summary.withCoordinates,errors:summary.errors.length}));
console.log('SMYTHS_SNAPSHOT_ERRORS', JSON.stringify(summary.errors));
