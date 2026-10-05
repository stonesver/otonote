import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageFile = '@esotericsoftware/spine-core/dist/index.js';
const localModule = fileURLToPath(new URL('../site/node_modules/' + packageFile, import.meta.url));
const runtimeModules = process.env.OURNOTES_NODE_MODULES_DIR || '/opt/ournotes-node/node_modules';
if (!isAbsolute(runtimeModules)) throw Error('Spine runtime modules path must be absolute');
const imageModule = join(runtimeModules, packageFile);
const moduleFile = [localModule, imageModule].find(existsSync);
if (!moduleFile) throw Error('spine-core runtime missing from local site and updater image');
const { SkeletonBinary, SkeletonJson, AtlasAttachmentLoader, TextureAtlas } =
  await import(pathToFileURL(moduleFile).href);
const [file, atlasFile, format] = process.argv.slice(2);
const atlas = new TextureAtlas(await readFile(atlasFile, 'utf8'));
const loader = new AtlasAttachmentLoader(atlas);
const parser = format === 'binary' ? new SkeletonBinary(loader) : new SkeletonJson(loader);
const bytes = await readFile(file);
const data = parser.readSkeletonData(format === 'binary' ? bytes : JSON.parse(bytes));
console.log(JSON.stringify(Object.fromEntries(data.animations.map(a => [a.name, a.duration]))));
