import test from 'node:test';
import assert from 'node:assert/strict';
import {activeNotices, deliveredVersion, updateKind, validNotice} from '../src/lib/site-notifications.mjs';

const code = 'a'.repeat(24), content = 'b'.repeat(24);
const current = {code, content};
const notice = extra => ({id:'c'.repeat(32), revision:1, kind:'info', region:'all', path:'/', title:'说明', body:'正文',
  titleEn:'', bodyEn:'', href:'', startsAt:null, endsAt:null, ...extra});
const envelope = (...notices) => ({schemaVersion:1, notices});
const multiNotice=paths=>{const row=notice();delete row.path;return {...row,paths};};
const context = {region:'global', route:'/my-growth/'};
const delivered = extra => ({schemaVersion:1, codeId:code, region:'global', pair:`${code}-${content}`,
  pointer:{schemaVersion:1, manifest:`/content/releases/${content}/manifest.json`, sha256:'d'.repeat(64)}, ...extra});

test('only completed, matching edition and internally consistent identities are accepted', () => {
  assert.deepEqual(deliveredVersion(delivered(), 'global'), {...current, key:`${code}-${content}`});
  for (const value of [null, {}, delivered({region:'jp'}), delivered({pair:'x'}), delivered({codeId:'wrong'}), delivered({codeId:[code]}),
    delivered({pointer:{manifest:[]}}), delivered({pointer:{manifest:`/content/releases/${content}/manifest.json`,sha256:'bad'}})]) {
    assert.equal(deliveredVersion(value,'global'),null);
  }
});

test('distinguishes code, content, combined and unchanged updates without replacing the current snapshot', () => {
  const before = {...current};
  assert.equal(updateKind(current,current),null);
  assert.equal(updateKind(current,{...current,code:'c'.repeat(24)}),'code');
  assert.equal(updateKind(current,{...current,content:'c'.repeat(24)}),'content');
  assert.equal(updateKind(current,{code:'c'.repeat(24),content:'d'.repeat(24)}),'both');
  assert.equal(updateKind({},current),null);
  assert.deepEqual(current,before);
});

test('counterpart edition changes may alter render identity without changing the target update', () => {
  const value=delivered({pair:`${code}-${'e'.repeat(24)}`});
  value.pointer.libraryPointers={jp:null};
  const next=deliveredVersion(value,'global');
  assert.equal(updateKind(current,next),null);
  assert.equal(next.key,`${code}-${content}`);
  assert.equal(deliveredVersion(delivered({pair:`${'f'.repeat(24)}-${content}`}), 'global'), null);
});

test('notices obey edition, page boundaries, schedule start and exclusive end', () => {
  const filter = (...rows) => activeNotices(envelope(...rows),context,100);
  assert.equal(filter(notice({region:'jp'})).length,0);
  assert.equal(filter(notice({path:'/music/'})).length,0);
  assert.equal(activeNotices(envelope(notice({path:'/my-growth/'})),{...context,route:'/my-growth-extra/'},100).length,0);
  assert.equal(filter(notice({startsAt:101})).length,0);
  assert.equal(filter(notice({endsAt:100})).length,0);
  assert.equal(filter(notice({startsAt:100,endsAt:101,path:'/my-growth/'})).length,1);
});

test('dismissal applies to a particular info revision, not incidents or revised notices', () => {
  const dismissed = new Set([`${'c'.repeat(32)}:1`]);
  const filter = row => activeNotices(envelope(row),context,100,dismissed);
  assert.equal(filter(notice()).length,0);
  assert.equal(filter(notice({revision:2})).length,1);
  assert.equal(filter(notice({kind:'incident'})).length,1);
  assert.equal(filter(notice({kind:'maintenance'})).length,1);
});

test('multiple scopes match either page and children once, preserving boundaries and legacy notices',()=>{
  const row=multiNotice(['/recruitment/','/events/']);
  for(const route of ['/recruitment/','/events/','/events/123/'])assert.equal(activeNotices(envelope(row),{...context,route},100).length,1);
  for(const route of ['/music/','/events-extra/'])assert.equal(activeNotices(envelope(row),{...context,route},100).length,0);
  assert.equal(activeNotices(envelope(multiNotice(['/events/','/events/123/'])),{...context,route:'/events/123/'},100).length,1);
  assert.equal(activeNotices(envelope(notice({path:'/events/'})),{...context,route:'/events/'},100).length,1);
  assert.equal(activeNotices(envelope(row),{...context,route:'/events/'},100,new Set([`${row.id}:1`])).length,0);
  for(const paths of [[],null,'/events/',['//evil/'],['/../'],[[]],Array(33).fill('/events/')])assert.equal(validNotice(multiNotice(paths)),false);
  assert.equal(validNotice({...row,path:'/'}),false);
});

test('incident and maintenance notices precede ordinary information', () => {
  const rows = activeNotices(envelope(notice(),notice({kind:'maintenance'}),notice({kind:'incident'})),context,100);
  assert.deepEqual(rows.map(row=>row.kind),['incident','maintenance','info']);
});

test('untrusted payloads and unsafe links are ignored', () => {
  for (const changed of [{id:['c'.repeat(32)]}, {title:[]}, {title:' '}, {revision:0}, {href:'//evil/'}, {href:'javascript:alert(1)'},
    {path:'/../'}, {endsAt:true}, {startsAt:Infinity}, {startsAt:100,endsAt:50}, {body:'a'.repeat(2001)}]) {
    assert.equal(validNotice(notice(changed)),false);
  }
  for (const value of [null, {}, {schemaVersion:1,notices:{}}, envelope(...Array(33).fill(notice()))]) {
    assert.deepEqual(activeNotices(value,context,100),[]);
  }
});

test('published Unicode notices use the server character limits without suppressing the feed',()=>{
  const row=notice({title:'😀'.repeat(120),titleEn:'😀'.repeat(120),body:'😀'.repeat(2000),bodyEn:'😀'.repeat(2000)});
  assert.equal(validNotice(row),true);
  assert.equal(activeNotices(envelope(row),context,100).length,1);
  assert.equal(validNotice({...row,title:row.title+'😀'}),false);
});
