import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDataProfiles,interactionPreloads} from '../../tools/web_client_dependencies.mjs';

test('page inputs follow shared static imports, deduplicate profiles and exclude lazy players', () => {
  const manifest = {buildRoot:'/code', routes:[{module:'page.js'}, {module:'page2.js'}]};
  const edge = path => ({path, kind:'import-statement'});
  const outputs = {
    '/code/page.js':{inputs:{'content:projection/catalog.json':{}}, imports:[edge('/code/shared.js'), {path:'/code/player.js', kind:'dynamic-import'}]},
    '/code/page2.js':{inputs:{'content:projection/catalog.json':{}}, imports:[edge('/code/shared.js')]},
    '/code/shared.js':{inputs:{'/src/cards.ts':{}, 'content:projection/media-index.json':{}}, imports:[edge('/code/shared.js')]},
    '/code/player.js':{inputs:{'content:supplemental/models.json':{}}, imports:[]}
  };
  attachDataProfiles(manifest, {outputs}, new Map([['/src/cards.ts', ['@projection-data/database-shards/member-cards/*.json']]]));
  assert.equal(manifest.dataProfiles.length, 1);
  assert.deepEqual(manifest.dataProfiles[0], {files:['projection/catalog.json', 'projection/media-index.json'], groups:['@projection-data/database-shards/member-cards/*.json']});
  assert.equal(manifest.routes[0].dataProfile, manifest.routes[1].dataProfile);
  assert.equal(manifest.buildRoot, undefined);
});

test('interaction preloads flatten static imports and keep lazy content and engines out',()=>{
 const edge=path=>({path,kind:'import-statement'});
 const outputs={
  '/code/scripts/tool.js':{entryPoint:'interaction:tool',imports:[edge('/code/chunks/shared.js'),{path:'/code/chunks/workspace.js',kind:'dynamic-import'}]},
  '/code/chunks/shared.js':{imports:[edge('/code/chunks/leaf.js')]},
  '/code/chunks/leaf.js':{imports:[edge('/code/chunks/shared.js'),{path:'external.js',kind:'import-statement',external:true}]},
  '/code/chunks/workspace.js':{entryPoint:'/src/shared-team-workspace.mjs',imports:[edge('/code/chunks/leaf.js'),{path:'/code/chunks/data.js',kind:'dynamic-import'}]},
  '/code/chunks/data.js':{imports:[]}
 };
 const result=interactionPreloads({outputs},'/code');
 assert.deepEqual(result.modulePreloads['scripts/tool.js'],['scripts/tool.js','chunks/shared.js','chunks/leaf.js']);
 assert.deepEqual(result.workspacePreloads,['chunks/workspace.js','chunks/leaf.js','chunks/shared.js']);
 assert.ok(!Object.values(result.modulePreloads).flat().includes('chunks/data.js'));
});
