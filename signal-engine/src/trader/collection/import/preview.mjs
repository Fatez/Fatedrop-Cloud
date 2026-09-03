import { listCollectionItemsFromStore } from '../store.mjs';
import { listCollectionImportSourcesFromStore } from '../import-source.mjs';
import { parseCollectrCsv } from './collectr-csv.mjs';
import { matchCollectionImportRowsFromStore } from './matcher.mjs';
import { planCollectionImportReconciliation } from './reconciliation.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

export async function previewCollectrImportFromStore(store, {
  userId,
  csvText,
  existingItemLimit = 2000,
} = {}) {
  const ownerId = requireText(userId,'userId');
  const parsed = parseCollectrCsv(csvText);
  const matched = await matchCollectionImportRowsFromStore(store,{rows:parsed.rows});
  const [existingSources,existingItems] = await Promise.all([
    listCollectionImportSourcesFromStore(store,{userId:ownerId,sourceName:'collectr'}),
    listCollectionItemsFromStore(store,{userId:ownerId,limit:existingItemLimit}),
  ]);
  const plan = planCollectionImportReconciliation({
    sourceName:'collectr',
    matches:matched.matches,
    existingSources,
    existingItems,
  });

  return Object.freeze({
    sourceName:'collectr',
    parsed:Object.freeze({acceptedRows:parsed.rows.length,rejectedRows:parsed.rejected.length,rejected:parsed.rejected}),
    matched:matched.summary,
    plan:plan.summary,
    scale:Object.freeze({
      existingItemsRead:existingItems.length,
      existingItemLimit,
      mayBeTruncated:existingItems.length >= existingItemLimit,
    }),
    rows:matched.matches,
    actions:plan,
  });
}
