import fs from 'node:fs/promises';

const OFFICIAL = [
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
'Bournemouth','Bristol Avonmeads','Bristol Cribbs Causeway','Bristol Longwell Green','Cheltenham','Exeter','Gloucester','Plymouth','Poole','Swindon','Weston-super-Mare'
];

const normalize = (v='') => String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const officialByNorm = new Map(OFFICIAL.map((name)=>[normalize(name),name]));
const slug = (v='') => normalize(v).replace(/\s+/g,'-');
const aliases = new Map([
  ['benfleet','Rayleigh Weir'],['bradwell common','Milton Keynes'],['broadstairs','Thanet'],['batley','Leeds Birstall'],['royton','Oldham'],['shirley','Solihull'],['lochee','Dundee'],['leckwith','Cardiff Leckwith'],['londonderry','Derry/Londonderry']
]);
const specialFromAddress = (label,address='') => {
  const a = normalize(address);
  if (label === 'London') {
    if (a.includes('friern bridge')) return 'Friern Barnet';
    if (a.includes('peninsular retail')) return 'Charlton';
    if (a.includes('gallions reach')) return 'Beckton';
    if (a.includes('staples corner')) return 'Staples Corner / Brent Cross';
  }
  if (label === 'Liverpool') {
    if (a.includes('new mersey') || a.includes('speke')) return 'Liverpool Speke';
    if (a.includes('edge lane')) return 'Liverpool Edge Lane';
    if (a.includes('north retail') || a.includes('portal way')) return 'Liverpool Croxteth';
  }
  if (label === 'Leeds') {
    if (a.includes('crown point')) return 'Leeds Crown Point';
    if (a.includes('kirkstall')) return 'Leeds Kirkstall';
  }
  if (label === 'Sheffield') {
    if (a.includes('drakehouse')) return 'Sheffield Drakehouse';
    if (a.includes('meadowhall') || a.includes('attercliffe')) return 'Sheffield Meadowhall';
  }
  if (label === 'Gateshead') {
    if (a.includes('team valley')) return 'Team Valley';
    if (a.includes('metro')) return 'Metro Centre';
  }
  if (label === 'Bristol') {
    if (a.includes('cribbs') || a.includes('lysander')) return 'Bristol Cribbs Causeway';
    if (a.includes('aldermoor') || a.includes('bs30')) return 'Bristol Longwell Green';
  }
  if (label === 'Southampton' && a.includes('hedge end')) return 'Hedge End';
  if (label === 'Birmingham' && a.includes('castlevale')) return 'Castlevale';
  if (label === 'Coventry' && a.includes('airport')) return 'Coventry Airport Park';
  if (label === 'Belfast' && a.includes('boucher')) return 'Boucher Road';
  if (label === 'Belfast' && a.includes('drumkeen')) return 'Forestside';
  return null;
};

function decode(v='') { return String(v).replace(/&amp;/gi,'&').replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/&nbsp;/gi,' '); }
function strip(v='') { return decode(String(v).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim(); }
async function fetchText(url) {
  const r = await fetch(url,{headers:{accept:'text/html,*/*;q=0.5','user-agent':'FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)'}});
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.text();
}
function extractDirectory(html,pageUrl) {
  const out=[];
  const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?Smyths[\s\S]*?)<\/a>/gi;
  for (const m of String(html).matchAll(re)) {
    const labelRaw=strip(m[2]).replace(/^Smyths\s+(?:Toys\s+Superstores\s+)?/i,'').trim();
    if (!labelRaw || /nearby/i.test(labelRaw)) continue;
    const after=String(html).slice(m.index + m[0].length, m.index + m[0].length + 900);
    const beforeContact=after.split(/Contact shop/i)[0];
    const addressText=strip(beforeContact).replace(/^[-–—\s]+/,'').trim();
    const postcodeMatch=addressText.match(/(?:-|–)\s*([A-Z]{1,2}\d[A-Z\d]?)\s+([A-Za-z][A-Za-z .'/()-]+)\s*$/i);
    if (!postcodeMatch) continue;
    const outward=postcodeMatch[1].toUpperCase();
    const city=postcodeMatch[2].trim();
    const street=addressText.slice(0,postcodeMatch.index).replace(/[-–—\s]+$/,'').trim();
    let official=specialFromAddress(labelRaw,`${street} ${outward} ${city}`);
    if (!official) official=aliases.get(normalize(labelRaw)) || officialByNorm.get(normalize(labelRaw)) || null;
    if (!official && officialByNorm.has(normalize(city))) official=officialByNorm.get(normalize(city));
    if (!official) continue;
    try {
      const href=new URL(decode(m[1]),pageUrl).toString();
      out.push({official,labelRaw,street,outward,city,directoryUrl:href});
    } catch {}
  }
  const unique=new Map();
  for (const row of out) if (!unique.has(row.official)) unique.set(row.official,row);
  return [...unique.values()];
}
async function geocode(row) {
  const q=`${row.street}, ${row.city}, ${row.outward}, United Kingdom`;
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=gb&q=${encodeURIComponent(q)}`;
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)'}});
  if (!r.ok) return {status:`http_${r.status}`};
  const values=await r.json();
  for (const item of Array.isArray(values)?values:[]) {
    const postcode=String(item?.address?.postcode || '').toUpperCase().trim();
    if (!postcode || !postcode.replace(/\s+/g,'').startsWith(row.outward.replace(/\s+/g,''))) continue;
    const latitude=Number(item.lat), longitude=Number(item.lon);
    if (!Number.isFinite(latitude)||!Number.isFinite(longitude)) continue;
    return {status:'ok',postcode,latitude,longitude,displayName:item.display_name};
  }
  return {status:'no_valid_match'};
}

const pages=['https://www.the-shops.co.uk/chainstore/1048-smyths','https://www.the-shops.co.uk/chainstore/1048-smyths/2'];
let directory=[];
for (const page of pages) directory.push(...extractDirectory(await fetchText(page),page));
directory=[...new Map(directory.map((r)=>[r.official,r])).values()];
console.log('SMYTHS_DIRECTORY_MATCHED',directory.length);
const accepted=[]; const rejected=[];
for (let i=0;i<directory.length;i++) {
  const row=directory[i];
  let result;
  try { result=await geocode(row); } catch (e) { result={status:'error',error:String(e?.message||e)}; }
  if (result.status==='ok') accepted.push({...row,...result}); else rejected.push({...row,...result});
  console.log('SMYTHS_GEOCODE',i+1,'/',directory.length,row.official,result.status);
  if (i+1<directory.length) await new Promise(r=>setTimeout(r,1100));
}
const generatedAt=new Date().toISOString();
const rows=accepted.map((r)=>({
  retailerId:'smyths-uk',
  branchName:`Smyths Toys — ${r.official}`,
  branchKey:`smyths-${slug(r.official)}`,
  address:`${r.street}, ${r.city}`,
  postcode:r.postcode,
  latitude:r.latitude,
  longitude:r.longitude,
  website:`https://www.smythstoys.com/uk/en-gb/storefinder/storedetails/${slug(r.official)}`,
  sourceUrl:r.directoryUrl,
  sourceType:'curated_crosschecked_branch',
  sourceAttribution:'Smyths official current branch directory cross-checked with UK shop directory and OpenStreetMap geocode',
  verification:'curated_branch',
  supportedTcgs:['pokemon'],
  notes:`Current Smyths branch identity cross-match; geocode accepted only when returned full postcode matched directory outward code ${r.outward}.`,
}));
const content=`// Generated ${generatedAt}. Review before production merge.\nexport const GENERATED_SMYTHS_BRANCH_SEEDS = Object.freeze(${JSON.stringify(rows,null,2)});\n`;
await fs.writeFile('tmp/smyths-curated-seeds.generated.mjs',content);
await fs.writeFile('tmp/smyths-curated-seeds.report.json',JSON.stringify({generatedAt,officialBranches:OFFICIAL.length,directoryMatched:directory.length,accepted:accepted.length,rejected:rejected.length,rejectedRows:rejected},null,2)+'\n');
console.log('SMYTHS_BULK_SUMMARY',JSON.stringify({official:OFFICIAL.length,directoryMatched:directory.length,accepted:accepted.length,rejected:rejected.length}));
