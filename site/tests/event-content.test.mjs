import assert from 'node:assert/strict';
import test from 'node:test';
import { validatedEvents, decorateEventStories, eventStoryEntryId } from '../src/lib/event-content.mjs';
import { activeNavigationChild, NAVIGATION_GROUPS } from '../src/lib/navigation.mjs';
import { collectEventCards } from '../src/lib/event-card-model.mjs';
const context = { region: 'jp', contentReleaseId: 'jp-release' };
const event = { id:1, edition:'jp', sourceReleaseId:'jp-release', exchanges:[], story:{ chapterId:6, episodes:[
  {id:601,number:1}, {id:602,number:2}, {id:608,number:1,isAnotherEpisode:true}
] } };
const archive = { edition:'jp',sourceReleaseId:'jp-release',records:[event] };
test('already published archives do not mix exchanges and reward cards when currency is reused', () => {
  const shops = [1,2].map(id => ({id, startAt:`2026-10-${id === 1 ? '01' : '10'} 15:00:00`,
    endAt:'2026-10-30 14:59:59', products:[{reward:{resourceType:3,resourceId:id,name:`Card ${id}`},cost:75000}]}));
  for (const region of ['global','jp']) {
    const records = [1,2].map(id => ({...event, id, edition:region,
      schedule:{startAt:`2026/10/${id === 1 ? '01' : '10'} 15:00:00`,endAt:`2026/10/${id === 1 ? '08' : '18'} 14:59:59`},
      exchanges:shops, pickupCards:[],achievements:[],effects:[],ranking:{rewards:[]},challengeSongs:[]}));
    const source = {...archive,edition:region,records};
    const before = structuredClone(source);
    const result = validatedEvents(source,{...context,region});
    assert.deepEqual(result.map(e=>e.exchanges.map(s=>s.id)),[[1],[2]]);
    assert.deepEqual(result.map(e=>collectEventCards(e,()=>null).map(c=>c.resourceId)),[[1],[2]]);
    assert.equal(result[0].exchanges[0].endAt,'2026-10-30 14:59:59');
    assert.deepEqual(source,before);
  }
});
test('events reject cross-server and stale-release content before routes are created', () => {
  assert.deepEqual(validatedEvents(archive,context),[event]);
  assert.throws(()=>validatedEvents(archive,{...context,region:'global'}),/selected edition/);
  assert.throws(()=>validatedEvents(archive,{...context,contentReleaseId:'new-release'}),/selected edition/);
  assert.throws(()=>validatedEvents({...archive,records:[{...event,edition:'global'}]},context),/selected edition/);
  assert.deepEqual(validatedEvents({records:[]},{region:'global'}),[]);
});
test('activity membership uses exact episode and chapter and preserves source records', () => {
  const entries = [601,608,602,700].map((id,index)=>({id:`story-entry-main-${id}`,chapterId:6,category:id===608?'viewpoint':'band',episodeNumber:id===602?2:1,group:'band-6',previousId:'unrelated',nextId:'unrelated'}));
  const before=structuredClone(entries);
  const result=decorateEventStories(entries,[event]);
  const main=result.filter(e=>e.eventSection==='main');
  assert.equal(main.length,2);
  assert.equal(main[0].previousId,null);
  assert.equal(main[0].nextId,eventStoryEntryId({id:602}));
  assert.equal(main[1].previousId,eventStoryEntryId({id:601}));
  assert.equal(main[1].nextId,null);
  const another=result.find(e=>e.eventSection==='another');
  assert.equal(another.eventId,1);
  assert.equal(another.previousId,null);
  assert.equal(another.nextId,null);
  assert.equal(result[3].eventId,undefined);
  assert.equal(decorateEventStories([{...entries[0],chapterId:99}],[event])[0].eventId,undefined);
  assert.deepEqual(entries,before);
});
test('event chapters stay in the story navigation and select their dedicated child', () => {
  const story = NAVIGATION_GROUPS.find(group=>group.id==='stories');
  assert.equal(activeNavigationChild('/stories/events/1/',story.children).href,'/stories/events/');
  assert.equal(activeNavigationChild('/stories/main/',story.children).href,'/stories/main/');
});
