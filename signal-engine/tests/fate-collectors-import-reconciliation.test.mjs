import test from 'node:test';
import assert from 'node:assert/strict';
import { planCollectionImportReconciliation } from '../src/trader/collection/import/reconciliation.mjs';

function exact(overrides={}) {
  return {
    status:'exact',fateCardId:'card1',sourceRecordKey:'r1',
    row:{sourceRecordKey:'r1',quantity:2,conditionCode:'near_mint',gradingCompany:'',gradeLabel:'',...overrides},
    ...overrides,
  };
}

test('new exact source row becomes a create action',()=>{
  const plan=planCollectionImportReconciliation({matches:[exact()]});
  assert.equal(plan.summary.create,1);
  assert.equal(plan.creates[0].collectionInput.fateCardId,'card1');
  assert.equal(plan.creates[0].collectionInput.quantity,2);
});

test('existing imported row becomes update instead of duplicate create',()=>{
  const plan=planCollectionImportReconciliation({
    matches:[exact()],
    existingSources:[{sourceName:'collectr',sourceRecordKey:'r1',collectionItemId:'i1'}],
    existingItems:[{id:'i1',fateCardId:'card1',quantity:1,conditionCode:'near_mint',copyState:'raw',revision:3,status:'active'}],
  });
  assert.equal(plan.summary.create,0);
  assert.equal(plan.summary.update,1);
  assert.equal(plan.updates[0].patch.quantity,2);
  assert.equal(plan.updates[0].expectedRevision,3);
});

test('missing rows are reported stale but never auto-deleted',()=>{
  const plan=planCollectionImportReconciliation({
    matches:[],
    existingSources:[{sourceName:'collectr',sourceRecordKey:'old',collectionItemId:'i1'}],
    existingItems:[{id:'i1',fateCardId:'card1',quantity:1,conditionCode:'near_mint',copyState:'raw',revision:1,status:'active'}],
  });
  assert.equal(plan.summary.staleSourceRecords,1);
  assert.equal(plan.staleSources[0].sourceRecordKey,'old');
});

test('ambiguous matches and multi-quantity graded rows are held for confirmation',()=>{
  const ambiguous=planCollectionImportReconciliation({matches:[{status:'needs_confirmation',reason:'exact_identity_ambiguous',row:{sourceRecordKey:'r1'}}]});
  assert.equal(ambiguous.summary.hold,1);
  const graded=planCollectionImportReconciliation({matches:[exact({quantity:2,gradingCompany:'PSA',gradeLabel:'10'})]});
  assert.equal(graded.summary.hold,1);
  assert.equal(graded.holds[0].reason,'graded_quantity_requires_split');
});
