import {build} from '../site/node_modules/esbuild/lib/main.js';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, copyFile} from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildPrerenderRuntime(stage) {
  const common = {bundle:true, minify:true, target:'es2022', write:true};
  await build({...common, platform:'node', format:'esm', entryPoints:[join(root,'tools/render_prerender.mjs')], outfile:resolve(stage,'prerender/render.mjs')});
  await build({...common, platform:'browser', format:'esm', entryPoints:[join(root,'site/src/runtime/prerender-resource.mjs')], outfile:resolve(stage,'prerender/resource.js')});
  await build({...common, platform:'browser', format:'iife', entryPoints:[join(root,'site/src/runtime/prerender-client.mjs')], outfile:resolve(stage,'prerender/bootstrap.js')});
  await build({...common, platform:'browser', format:'iife', loader:{'.css':'text'}, entryPoints:[join(root,'site/src/runtime/navigation-client.mjs')], outfile:resolve(stage,'prerender/navigation.js')});
  await mkdir(join(stage,'loading'), {recursive:true});
  await copyFile(join(root,'site/public/brand/ournotes-mark.svg'),join(stage,'loading/brand-fallback.svg'));
}
