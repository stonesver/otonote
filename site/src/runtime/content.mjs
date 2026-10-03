/** One immutable content snapshot per document, shared by independently loaded modules. */
const stateKey = Symbol.for('ournotes.content.snapshot.v1');
function state() {
  return globalThis[stateKey] ??= { documents: new Map() };
}
export function pageContext(pathname = globalThis.location?.pathname ?? '/global/zh-CN/') {
  const match = pathname.match(/^\/(global|jp)\/(zh-CN|en)(\/.*)?$/);
  const region = match?.[1] ?? 'global', locale = match?.[2] ?? 'zh-CN';
  return { region, locale, base: `/${region}/${locale}/`, route: match?.[3] ?? '/' };
}
export async function checkedJson(url, expected, fetcher = fetch, {timeoutMs = 20000} = {}) {
  const response = await fetcher(url, { cache: expected ? 'force-cache' : 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`内容读取失败 (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (expected) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== expected) throw new Error('内容校验失败，请稍后重试');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function validatePointer(value) {
  if (value?.schemaVersion !== 1 || !/^\/content\/releases\/[a-f0-9]{24}\/manifest\.json$/.test(value.manifest)
      || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('网站与内容版本不兼容');
  return value;
}
export async function snapshot() {
  const shared = state();
  shared.promise ??= (async () => {
    const context = pageContext();
    const pointer = validatePointer(await checkedJson(context.region === 'global' ? '/content/current.json' : '/content/jp/current.json'));
    const manifest = await checkedJson(pointer.manifest, pointer.sha256);
    const root = pointer.manifest.slice(0, -'manifest.json'.length);
    const region = manifest.region ?? (manifest.contentReleaseId?.startsWith('global-') ? 'global' : null);
    if (manifest.schemaVersion !== 1 || manifest.root !== root || region !== context.region || !manifest.locales?.[context.locale]) {
      throw new Error('网站与内容版本不兼容');
    }
    // Publish the validated root before any parallel template import can derive
    // media URLs from its data. Import completion must not control this timing.
    globalThis[Symbol.for('ournotes.content-root.v1')] = root;
    return manifest;
  })();
  return shared.promise;
}
async function readRecord(record) {
  const manifest = await snapshot();
  if (!record || typeof record.path !== 'string' || record.path.startsWith('/') || record.path.split('/').some(p => !p || p === '..')
      || /[%?#\\]/.test(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('内容文件清单不完整');
  const url = manifest.root + record.path;
  const shared = state();
  if (!shared.documents.has(url)) shared.documents.set(url, checkedJson(url, record.sha256));
  return shared.documents.get(url);
}
export async function artifact(name, {optional = false} = {}) {
  const manifest = await snapshot();
  const record = manifest.locales[pageContext().locale].files[name];
  if (optional && !record) return null;
  return readRecord(record);
}
export async function artifactGlob(pattern, options = {}) {
  const manifest = await snapshot();
  const records = manifest.locales[pageContext().locale];
  const prefix = '@projection-data/';
  if (!pattern.startsWith(prefix)) throw new Error('不支持的内容分组');
  if (!pattern.includes('*')) {
    const value = await artifact('projection/' + pattern.slice(prefix.length), {optional: true});
    if (value === null) return {}; // Vite exact globs also return no matches for absent files.
    return { [pattern]: options.import === 'default' ? value : { default: value } };
  }
  let values;
  if (pattern === '@projection-data/story-text/*.json') {
    const id = pageContext().route.match(/^\/stories\/episodes\/([^/]+)\/?$/)?.[1];
    if (!id) return {};
    const name = 'projection/story-text/' + id + '.json';
    if (!records.files[name]) return {};
    values = { [pattern.replace('*', id)]: await artifact(name) };
  } else {
    values = await readRecord(records.groups[pattern]);
  }
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, options.import === 'default' ? value : { default: value }]));
}

/** Independent, immutable snapshots for reference material from another edition. */
export async function editionSnapshot(region) {
  if (!['global', 'jp'].includes(region)) throw new Error('未知游戏版本');
  if (region === pageContext().region) return snapshot();
  const shared = state();
  shared.editions ??= new Map();
  if (!shared.editions.has(region)) shared.editions.set(region, (async () => {
    if(shared.pointers && Object.hasOwn(shared.pointers,region) && shared.pointers[region]===null)throw new Error('此版本资料待补充');
    const pointer = validatePointer(shared.pointers?.[region] ?? await checkedJson(`/content/${region}/current.json`));
    const manifest = await checkedJson(pointer.manifest, pointer.sha256);
    const root = pointer.manifest.slice(0, -'manifest.json'.length);
    const identity = manifest.region ?? manifest.contentReleaseId?.split('-')[0];
    if (manifest.schemaVersion !== 1 || manifest.root !== root || identity !== region || !manifest.locales?.[pageContext().locale]) {
      throw new Error('网站与内容版本不兼容');
    }
    return manifest;
  })());
  return shared.editions.get(region);
}

export async function editionArtifact(region, name, {optional = false} = {}) {
  const manifest = await editionSnapshot(region);
  const record = manifest.locales[pageContext().locale].files[name];
  if (!record && optional) return null;
  return editionRecord(manifest, record);
}
async function editionRecord(manifest, record) {
  if (!record || typeof record.path !== 'string' || record.path.startsWith('/') || record.path.split('/').some(p => !p || p === '..')
      || /[%?#\\]/.test(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('内容文件清单不完整');
  const shared = state(), url = manifest.root + record.path;
  if (!shared.documents.has(url)) shared.documents.set(url, checkedJson(url, record.sha256));
  return shared.documents.get(url);
}

export async function otherEditionArtifact(region, name) {
  try { return await editionArtifact(region === 'jp' ? 'global' : 'jp', name, {optional:true}); }
  catch { return null; }
}

export async function otherEditionGroup(region, pattern) {
  try {
    const manifest=await editionSnapshot(region==='jp'?'global':'jp');
    const record=manifest.locales[pageContext().locale].groups[pattern];
    return record ? await editionRecord(manifest,record) : null;
  } catch { return null; }
}
