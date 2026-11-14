import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

// npm exec --yes --package=assemblyscript@0.28.20 -- node tools/build_pairing_kernel.mjs
// The optional argument selects an already installed asc executable.
const source=fileURLToPath(new URL('../packages/scoring/scoring-rules/maximum-pairing-kernel.ts',import.meta.url));
const target=fileURLToPath(new URL('../packages/scoring/scoring-rules/maximum-pairing-kernel.mjs',import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),'pairing-kernel-'));
try{
  const output=join(temporary,'pairing.wasm');
  execFileSync(process.argv[2]??'asc',[source,'--runtime','stub','--importMemory','--initialMemory','1',
    '--optimizeLevel','3','--shrinkLevel','2','--noAssert','--outFile',output],{stdio:'inherit'});
  const binary=readFileSync(output).toString('base64');
  writeFileSync(target,readFileSync(target,'utf8').replace(/atob\('[A-Za-z0-9+/=]+'\)/,`atob('${binary}')`));
}finally{rmSync(temporary,{recursive:true,force:true});}
