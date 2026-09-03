import { listVerifiedCardSetsFromStore } from '../../catalogue/store.mjs';
import { readCollectorVerifiedSetCardsFromStore } from '../collector-read-store.mjs';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function key(value) {
  return text(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/[^a-z0-9]+/g,'');
}

function collectorKey(value) {
  const raw = text(value).toUpperCase().replace(/\s+/g,'');
  const slash = raw.match(/^(\d+)\/\d+$/);
  if (slash) return String(Number(slash[1]));
  if (/^\d+$/.test(raw)) return String(Number(raw));
  return raw.replace(/[^A-Z0-9-]+/g,'');
}

function variantKey(value) {
  const raw = key(value);
  const aliases = {
    normal:'standard', standard:'standard', nonholo:'standard', regular:'standard',
    holo:'holo', holofoil:'holo', foil:'holo',
    reverseholo:'reverseholo', reversefoil:'reverseholo',
  };
  return aliases[raw] ?? raw;
}

function publicCandidate(card) {
  return Object.freeze({
    fateCardId: card.fateCardId ?? card.id,
    printingId: card.printingId,
    setId: card.setId,
    setName: card.setName ?? null,
    tcgCode: card.tcgCode ?? null,
    name: card.name ?? null,
    collectorNumber: card.collectorNumber,
    variantCode: card.variantCode ?? null,
    languageCode: card.languageCode ?? null,
  });
}

async function setsFor(store, cache, tcgCode) {
  if (!cache.has(tcgCode)) cache.set(tcgCode, await listVerifiedCardSetsFromStore(store,{tcgCode,limit:1000}));
  return cache.get(tcgCode);
}

async function cardsFor(store, cache, setId) {
  if (!cache.has(setId)) cache.set(setId, await readCollectorVerifiedSetCardsFromStore(store,{setId}));
  return cache.get(setId);
}

export async function matchCollectionImportRowsFromStore(store, { rows } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const setCache = new Map();
  const cardCache = new Map();
  const matches = [];

  for (const row of rows) {
    const tcgCode = text(row?.tcgCode).toLowerCase();
    const rowResult = { sourceRecordKey:row?.sourceRecordKey ?? null, sourceRow:row?.sourceRow ?? null, row };
    if (!tcgCode || !text(row?.setName) || !text(row?.collectorNumber)) {
      matches.push(Object.freeze({ ...rowResult, status:'unresolved', reason:'insufficient_import_identity', candidates:Object.freeze([]) }));
      continue;
    }

    const sets = await setsFor(store,setCache,tcgCode);
    const setCandidates = sets.filter((set) => key(set.name) === key(row.setName));
    if (setCandidates.length === 0) {
      matches.push(Object.freeze({ ...rowResult, status:'unresolved', reason:'set_not_found', candidates:Object.freeze([]) }));
      continue;
    }
    if (setCandidates.length > 1) {
      matches.push(Object.freeze({ ...rowResult, status:'ambiguous', reason:'set_ambiguous', candidates:Object.freeze(setCandidates.map((set)=>Object.freeze({setId:set.id,setName:set.name,tcgCode:set.tcgCode}))) }));
      continue;
    }

    const set = setCandidates[0];
    const cardRead = await cardsFor(store,cardCache,set.id);
    if(cardRead.truncated){
      matches.push(Object.freeze({
        ...rowResult,setId:set.id,status:'unresolved',reason:'canonical_set_read_truncated',candidates:Object.freeze([]),
      }));
      continue;
    }
    const cards=cardRead.cards;
    let numbered = cards.filter((card) => collectorKey(card.collectorNumber) === collectorKey(row.collectorNumber));
    if (numbered.length === 0) {
      matches.push(Object.freeze({ ...rowResult, setId:set.id, status:'unresolved', reason:'card_number_not_found', candidates:Object.freeze([]) }));
      continue;
    }

    const named = text(row.cardName) ? numbered.filter((card) => key(card.name) === key(row.cardName)) : [];
    if (named.length) numbered = named;

    const byPrinting = new Map();
    for (const card of numbered) {
      if (!byPrinting.has(card.printingId)) byPrinting.set(card.printingId,[]);
      byPrinting.get(card.printingId).push(card);
    }
    if (byPrinting.size > 1) {
      matches.push(Object.freeze({ ...rowResult, setId:set.id, status:'ambiguous', reason:'printing_ambiguous', candidates:Object.freeze(numbered.map(publicCandidate)) }));
      continue;
    }

    const identities = [...byPrinting.values()][0];
    let exactCandidates = identities;
    if (text(row.languageCode)) exactCandidates = exactCandidates.filter((card)=>key(card.languageCode) === key(row.languageCode));
    if (text(row.variantLabel)) exactCandidates = exactCandidates.filter((card)=>variantKey(card.variantCode) === variantKey(row.variantLabel));

    if (exactCandidates.length === 1) {
      matches.push(Object.freeze({
        ...rowResult,
        setId:set.id,
        status:'exact',
        reason:null,
        fateCardId:exactCandidates[0].fateCardId ?? exactCandidates[0].id,
        printingId:exactCandidates[0].printingId,
        candidates:Object.freeze([publicCandidate(exactCandidates[0])]),
      }));
      continue;
    }

    matches.push(Object.freeze({
      ...rowResult,
      setId:set.id,
      status:'needs_confirmation',
      reason: exactCandidates.length === 0 ? 'source_variant_or_language_not_resolved' : 'exact_identity_ambiguous',
      printingId:identities[0]?.printingId ?? null,
      candidates:Object.freeze(identities.map(publicCandidate)),
    }));
  }

  const summary = { total:matches.length, exact:0, needsConfirmation:0, ambiguous:0, unresolved:0 };
  for (const match of matches) {
    if (match.status === 'exact') summary.exact += 1;
    else if (match.status === 'needs_confirmation') summary.needsConfirmation += 1;
    else if (match.status === 'ambiguous') summary.ambiguous += 1;
    else summary.unresolved += 1;
  }
  return Object.freeze({ summary:Object.freeze(summary), matches:Object.freeze(matches) });
}
