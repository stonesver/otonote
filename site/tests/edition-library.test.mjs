import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeEditionRows, mergeCatalogs, presenceLabel} from '../src/lib/edition-library.mjs';
import {pageEditionHref, rankingServerHref} from '../src/lib/page-edition.mjs';
const options = {region:'global', key:r=>r.proof, path:r=>`/cards/${r.id}/`};
test('same numeric ID never establishes cross-edition identity',()=>{
  const rows=mergeEditionRows([{id:1,proof:'a'}],[{id:1,proof:'b'}],options);
  assert.equal(rows.length,2);assert.equal(rows[1].id,'jp--1');
  assert.equal(rows[1].sourceHref,'/jp/zh-CN/cards/1/');
  assert.equal(presenceLabel(rows[1].editionPresence),'日服独有');
});
test('unique evidence joins content, ambiguous and missing evidence do not',()=>{
  assert.equal(mergeEditionRows([{id:1,proof:'a'}],[{id:2,proof:'a'}],options).length,1);
  assert.equal(mergeEditionRows([{id:1,proof:'a'}],[{id:2,proof:'a'},{id:3,proof:'a'}],options).length,3);
  assert.equal(mergeEditionRows([{id:1}],[{id:1}],options).length,2);
  assert.equal(presenceLabel(mergeEditionRows([{id:1}],null,options)[0].editionPresence),'');
  assert.equal(presenceLabel({status:'known',editions:['global','jp'],different:true}),'');
});
test('page switch keeps filters, resets pagination, never assumes a detail counterpart',()=>{
  const href=pageEditionHref('/global/zh-CN/events/12/','?server=global-en&page=3&q=hello','jp','zh-CN');
  const url=new URL(href,'https://test.invalid');
  assert.equal(url.pathname,'/jp/zh-CN/events/');assert.equal(url.searchParams.get('q'),'hello');
  assert.equal(url.searchParams.get('view'),'page');assert.equal(url.searchParams.get('unavailable'),'/events/12/');
  assert.equal(url.searchParams.has('server'),false);assert.equal(url.searchParams.has('page'),false);
  assert.equal(new URL(pageEditionHref('/global/zh-CN/events/12/','','global','zh-CN'),'https://test.invalid').pathname,'/global/zh-CN/events/12/');
  const rank=new URL(rankingServerHref('/global/en/rankings/','?event=12&board=music&cursor=old','jp'),'https://test.invalid');
  assert.equal(rank.pathname,'/jp/en/rankings/');assert.equal(rank.searchParams.has('event'),false);assert.equal(rank.searchParams.get('board'),'music');
});
test('foreign cards keep distinct media and reference a verified common character',()=>{
  const catalog=region=>({release:{id:region,region},assets:[{id:'a',sha256:'portrait'},{id:'c',sha256:region}],bands:[],characters:[{id:'character-1',profileAssetId:'a',birthday:{month:1,day:1},role:'vocal'}],memberCards:[{id:'member-1',primaryAssetId:'c',characterId:'character-1',rarity:3,attributeCode:1,assetId:1}],supportCards:[],musicTracks:[],musicCharts:[]});
  const a=catalog('global'),b=catalog('jp'),rows=mergeCatalogs(a,b,'en');
  assert.equal(rows.characters.length,1);assert.equal(rows.memberCards.length,2);
  assert.equal(rows.memberCards[1].characterId,'character-1');assert.equal(rows.memberCards[1].primaryAssetId,'jp--c');
  assert.equal(rows.memberCards[1].sourceHref,'/jp/en/cards/members/member-1/');
  assert.equal(b.memberCards[0].primaryAssetId,'c','source snapshot is immutable');
});

function cardCatalog(region, kind) {
  const member = kind === 'memberCards';
  const path = `Assets/AddressableResources/${member ? 'MemberCard' : 'SupportCard'}/61/${member ? 'member_full' : 'snap_full'}.png`;
  return {
    release:{id:region,region}, bands:[], characters:[], musicTracks:[], musicCharts:[],
    memberCards:[], supportCards:[],
    assets:[{id:'art',sha256:`png-encoding-${region}`,containerPath:path,sourceBundle:`bundle-${region}`}],
    [kind]:[{id:'card-61',masterId:61,assetId:61,primaryAssetId:'art',thumbnailAssetId:'art',
      sourceContainerPath:path,rarity:4,attributeCode:2,
      ...(member ? {characterId:'character-15'} : {featuredCharacterIds:['character-15','character-12']}),
      performancePowerMax:100,contentComparison:'same-skills'}]
  };
}

for (const kind of ['memberCards','supportCards']) {
  for (const region of ['global','jp']) {
    test(`${kind}: ${region} merges re-encoded and repackaged artwork by its resource binding`,()=>{
      const other=region==='global'?'jp':'global';
      const primary=cardCatalog(region,kind),secondary=cardCatalog(other,kind);
      // Text, release IDs, bundle versions and PNG bytes can change independently.
      primary[kind][0].displayName='Localized title';secondary[kind][0].displayName='別の翻訳';
      secondary[kind][0].performancePowerMax=120;
      if(kind==='supportCards')secondary[kind][0].featuredCharacterIds.reverse();
      const before=structuredClone([primary,secondary]);
      const rows=mergeCatalogs(primary,secondary,'en')[kind];
      assert.equal(rows.length,1);
      assert.equal(rows[0].primaryAssetId,'art');
      assert.equal(rows[0].sourceEdition,region);
      assert.deepEqual(rows[0].editionPresence.editions,['global','jp']);
      assert.equal(rows[0].editionPresence.different,true,'stat changes remain edition differences');
      assert.equal(rows[0].editionPresence.counterparts[0].edition,other);
      assert.match(rows[0].editionPresence.counterparts[0].href,new RegExp(`^/${other}/en/cards/`));
      assert.deepEqual([primary,secondary],before,'input snapshots stay immutable');
    });
  }

  test(`${kind}: incomplete, conflicting and ambiguous resource evidence stays separate`,()=>{
    const changes=[
      c=>{delete c[kind][0].sourceContainerPath;},
      c=>{delete c.assets[0].containerPath;},
      c=>{c.assets[0].containerPath=c.assets[0].containerPath.replace('/61/','/62/');},
      c=>{c[kind][0].assetId=62;},
      c=>{c[kind][0].rarity=3;},
      c=>{c[kind][0].attributeCode=1;},
      c=>{if(kind==='memberCards')c[kind][0].characterId='character-99';else c[kind][0].featuredCharacterIds=['character-99'];},
      c=>{if(kind==='memberCards')delete c[kind][0].characterId;else c[kind][0].featuredCharacterIds=[];}
    ];
    for(const change of changes){
      const primary=cardCatalog('global',kind),secondary=cardCatalog('jp',kind);change(secondary);
      assert.equal(mergeCatalogs(primary,secondary,'en')[kind].length,2);
    }
    const primary=cardCatalog('global',kind),secondary=cardCatalog('jp',kind);
    secondary[kind].push({...secondary[kind][0],id:'another-card'});
    assert.equal(mergeCatalogs(primary,secondary,'en')[kind].length,3);
  });
}
