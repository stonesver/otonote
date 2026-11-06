import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compile} from 'svelte/compiler';

// Node controller tests load the same client component source as the web build.
registerHooks({load(url,context,nextLoad){
  if(!url.endsWith('.svelte'))return nextLoad(url,context);
  const filename=fileURLToPath(url);
  return {format:'module',shortCircuit:true,source:compile(readFileSync(filename,'utf8'),{filename,generate:'client',css:'injected'}).js.code};
}});
