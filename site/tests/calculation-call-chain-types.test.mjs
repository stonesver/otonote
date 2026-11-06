import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from '../node_modules/typescript/lib/typescript.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const config=ts.readConfigFile(root+'site/tsconfig.calculation.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root+'site',undefined,root+'site/tsconfig.calculation.json');
function diagnostics(replacement) {
  const host=ts.createCompilerHost(parsed.options),read=host.readFile.bind(host);
  host.readFile=path=>path===replacement?.path?replacement.source:read(path);
  const program=ts.createProgram(parsed.fileNames,parsed.options,host);
  return ts.getPreEmitDiagnostics(program);
}
test('strict checking reaches the real request, settings and report producers',()=>{
  assert.deepEqual(diagnostics().map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
  const mutations=[
    ['inventory-optimizer-ui.ts','rules,draft,scope,inventory,constraints,objective,mode,','rules,draft,scope,inventory,constraints,objective:"expectedScore",mode,'],
    ['inventory-optimizer-ui.ts',"sendOptimizerCommand(worker,{type:'cancel'})","sendOptimizerCommand(worker,{type:'cancelled'})"],
    ['team-planning-optimizer.ts',"status: cancelled ? 'cancelled'", "status: cancelled ? 'stopped'"],
    ['calculation/planning-settings.ts','seed:20261004','seed:"20261004"'],
  ];
  for(const [file,from,to] of mutations) {
    const path=root+'site/src/lib/'+file,original=readFileSync(path,'utf8');
    assert.ok(original.includes(from),`mutation target changed: ${file}`);
    const errors=diagnostics({path,source:original.replace(from,to)});
    assert.ok(errors.some(d=>d.file?.fileName===path&&[2322,2345,2820].includes(d.code)),`${file} must reject ${to}`);
  }
});
