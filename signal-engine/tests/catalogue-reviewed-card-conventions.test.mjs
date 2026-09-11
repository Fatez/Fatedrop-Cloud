import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePokemonCardCollections } from '../src/trader/catalogue/pipeline.mjs';

function setMatch(tcgdexSetId,pokemonSetId=tcgdexSetId){
  return {
    status:'matched',
    canonicalSeriesId:'fdseries_test',
    canonicalSetId:'fdset_test',
    tcgCode:'pokemon',
    evidence:[
      {sourceName:'tcgdex',sourceRecordId:tcgdexSetId},
      {sourceName:'pokemontcg-api',sourceRecordId:pokemonSetId},
    ],
  };
}

function tcgdexCard({setId,localId,name}){
  return {
    id:`${setId}-${localId}`,
    localId,
    name,
    category:'Pokemon',
    rarity:'Rare',
    set:{id:setId,name:'Test'},
    variants:{normal:true,reverse:false,holo:false,firstEdition:false},
  };
}

function pokemonCard({setId,number,name}){
  return {
    id:`${setId}-${number}`,
    number,
    name,
    supertype:'Pokémon',
    rarity:'Rare',
    set:{id:setId,name:'Test',series:'Test'},
  };
}

test('reviewed LV.X suffix convention remains exact and auditable',()=>{
  const result=reconcilePokemonCardCollections({
    tcgdexCards:[tcgdexCard({setId:'dpp',localId:'DP17',name:'Dialga'})],
    pokemonTcgCards:[pokemonCard({setId:'dpp',number:'DP17',name:'Dialga LV.X'})],
    setMatch:setMatch('dpp'),
    sourceSeriesCode:'dp',
  });
  assert.equal(result.checklistPrintings.length,1);
  assert.equal(result.matched.length,1);
  assert.deepEqual(result.matched[0].acceptedDifferences,[{
    field:'cardName',left:'Dialga',right:'Dialga LV.X',
    reason:'reviewed_pokemontcg_lv_x_suffix_convention',
  }]);
});

test('LV.X convention refuses a different collector number',()=>{
  const result=reconcilePokemonCardCollections({
    tcgdexCards:[tcgdexCard({setId:'dpp',localId:'DP17',name:'Dialga'})],
    pokemonTcgCards:[pokemonCard({setId:'dpp',number:'DP18',name:'Dialga LV.X'})],
    setMatch:setMatch('dpp'),
    sourceSeriesCode:'dp',
  });
  assert.equal(result.checklistPrintings.length,0);
  assert.equal(result.matched.length,0);
  assert.equal(result.unmatched.length,1);
});

test('Aquapolis and Skyridge accept only the reviewed H01 to H1 zero-padding convention',()=>{
  for(const setId of ['ecard2','ecard3']){
    const result=reconcilePokemonCardCollections({
      tcgdexCards:[tcgdexCard({setId,localId:'H01',name:'Alakazam'})],
      pokemonTcgCards:[pokemonCard({setId,number:'H1',name:'Alakazam'})],
      setMatch:setMatch(setId),
      sourceSeriesCode:'ecard',
    });
    assert.equal(result.checklistPrintings.length,1);
    assert.equal(result.matched.length,1);
    assert.equal(result.matched[0].acceptedDifferences[0].reason,'reviewed_ecard_holo_zero_padding_convention');
  }
});

test('H-number zero-padding convention stays fail-closed outside reviewed e-Card sets',()=>{
  const result=reconcilePokemonCardCollections({
    tcgdexCards:[tcgdexCard({setId:'other',localId:'H01',name:'Alakazam'})],
    pokemonTcgCards:[pokemonCard({setId:'other',number:'H1',name:'Alakazam'})],
    setMatch:setMatch('other'),
    sourceSeriesCode:'other',
  });
  assert.equal(result.checklistPrintings.length,0);
  assert.equal(result.matched.length,0);
});
