import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function checkCalculationTypes() {
  const root=fileURLToPath(new URL('../',import.meta.url));
  execFileSync(process.execPath,['site/node_modules/typescript/bin/tsc','-p','site/tsconfig.calculation.json'],{cwd:root,stdio:'inherit'});
  execFileSync(process.execPath,['site/node_modules/svelte-check/bin/svelte-check','--workspace','site','--tsconfig','./tsconfig.calculation.json','--fail-on-warnings'],{cwd:root,stdio:'inherit'});
}
if(process.argv[1]===fileURLToPath(import.meta.url))checkCalculationTypes();
