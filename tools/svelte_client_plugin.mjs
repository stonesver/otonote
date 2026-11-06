import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import compiler from '../site/node_modules/svelte/compiler/index.js';

const {compile} = compiler;

/** Client-mounted result components; Astro page rendering stays independent. */
export function svelteClientPlugin() {
  return {name:'svelte-client',setup(build){
    build.onLoad({filter:/\.svelte$/},async ({path})=>{
      const {js,warnings}=compile(await readFile(path,'utf8'),{filename:path,generate:'client',css:'injected'});
      return {contents:js.code,loader:'js',resolveDir:dirname(path),warnings:warnings.map(w=>({text:w.message}))};
    });
  }};
}
