import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join, relative} from 'node:path';
import postcss from 'postcss';

const source = new URL('../src/', import.meta.url).pathname;
const files = (await readdir(source, {recursive:true})).filter(path => /\.(css|astro|svelte)$/.test(path));
const palette = await readFile(join(source, 'styles/theme-tokens.css'), 'utf8');
const tokens = new Set([...palette.matchAll(/(--theme-[\w-]+)\s*:/g)].map(match => match[1]));
const literalColor = /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b/i;
const semanticComment = /Game semantics:|Alpha mask:/;

function documented(declaration) {
  const rule = declaration.parent;
  return rule.nodes.some(node => node.type === 'comment' && semanticComment.test(node.text))
    || (rule.prev()?.type === 'comment' && semanticComment.test(rule.prev().text));
}

test('page and component UI colors resolve through shared tokens; fixed game colors are documented', async () => {
  const violations = [];
  for (const file of files) {
    const text = await readFile(join(source, file), 'utf8');
    for (const [,token] of text.matchAll(/var\((--theme-[\w-]+)/g)) {
      if (!tokens.has(token)) violations.push(`${file}: undefined ${token}`);
    }
    if (file === 'styles/theme-tokens.css') continue;
    const sheets = file.endsWith('.css') ? [text] : [...text.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(match => match[1]);
    for (const sheet of sheets) {
      postcss.parse(sheet, {from:join(source, file)}).walkDecls(declaration => {
        if (!declaration.prop.includes('mask') && literalColor.test(declaration.value) && !documented(declaration)) {
          violations.push(`${relative(source, declaration.source.input.file)}:${declaration.source.start.line} ${declaration.prop}: ${declaration.value}`);
        }
      });
    }
  }
  assert.deepEqual(violations, []);
});
