import assert from 'node:assert/strict';
import test from 'node:test';
import { listVerifiedCardSetsFromStore } from '../src/trader/catalogue/store.mjs';
test('file catalogue exposes code and canonical ID without name inference', async () => {
  const store={read:async()=>({traderCatalogue:{tcgs:{t:{code:'pokemon'}},series:{},sets:{s:{id:'canonical-set',code:'sv03.5',tcgId:'t',name:'151',verificationStatus:'verified'}}}})};
  const [set]=await listVerifiedCardSetsFromStore(store);
  assert.equal(set.code,'sv03.5'); assert.equal(set.id,'canonical-set'); assert.equal(set.tcgCode,'pokemon');
});
test('postgres catalogue exposes the same code and identity contract', async () => {
  const store={pool:async()=>({query:async()=>({rows:[{id:'canonical-set',code:'sv03.5',tcg_code:'pokemon',name:'151',verification_status:'verified'}]})})};
  const [set]=await listVerifiedCardSetsFromStore(store);
  assert.equal(set.code,'sv03.5'); assert.equal(set.id,'canonical-set'); assert.equal(set.tcgCode,'pokemon');
});
