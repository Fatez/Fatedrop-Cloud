import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectrTokenMatchesCsv,
  makeCollectrConfirmationToken,
  makeCollectrImportBatchKey,
} from '../src/trader/collection/import/confirmation-token.mjs';

function preview(revision=3) {
  return {
    scale:{mayBeTruncated:false,existingItemsRead:1,existingItemLimit:2000},
    actions:{
      creates:[{sourceRecordKey:'row-create',match:{fateCardId:'card-1'},collectionInput:{fateCardId:'card-1',quantity:2,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint'}}],
      updates:[{match:{fateCardId:'card-2',row:{sourceRecordKey:'row-update'}},item:{id:'item-2',revision},expectedRevision:revision,patch:{quantity:4,conditionCode:'near_mint'}}],
      unchanged:[{match:{fateCardId:'card-3',row:{sourceRecordKey:'row-same'}},item:{id:'item-3',revision:1},source:{sourceRecordKey:'row-same'}}],
      holds:[{match:{status:'ambiguous',row:{sourceRecordKey:'row-held'},candidates:[{fateCardId:'card-a'},{fateCardId:'card-b'}]},reason:'printing_ambiguous'}],
      staleSources:[],
    },
  };
}

const csv='Card Name,Set,Card Number,Quantity\nPikachu,151,025,2\n';

test('Collectr confirmation token is deterministic and bound to the CSV',()=>{
  const first=makeCollectrConfirmationToken({csvText:csv,preview:preview()});
  const second=makeCollectrConfirmationToken({csvText:csv,preview:preview()});
  assert.equal(first,second);
  assert.equal(collectrTokenMatchesCsv(first,csv),true);
  assert.equal(collectrTokenMatchesCsv(first,`${csv}Mew,151,151,1\n`),false);
  assert.equal(makeCollectrImportBatchKey(first),makeCollectrImportBatchKey(second));
});

test('Collectr confirmation token changes when collection revision changes after preview',()=>{
  const first=makeCollectrConfirmationToken({csvText:csv,preview:preview(3)});
  const second=makeCollectrConfirmationToken({csvText:csv,preview:preview(4)});
  assert.notEqual(first,second);
});

test('invalid confirmation tokens cannot produce import batch keys',()=>{
  assert.throws(()=>makeCollectrImportBatchKey('not-a-preview-token'),/confirmationToken is invalid/i);
});
