import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fallbackLoadingArt, loadingArtFiles} from '../site/src/runtime/loading-presentation.mjs';

/** Select media from the already pinned, local immutable content snapshot. */
export async function prerenderLoadingArt({store, contentRoot, codeRoot}) {
  if (!/^\/content\/releases\/[a-f0-9]{24}\/$/.test(contentRoot)) throw Error('Invalid loading art snapshot');
  const art = fallbackLoadingArt(codeRoot);
  for (const file of loadingArtFiles) {
    const path = contentRoot.slice('/content/'.length) + 'public/gallery/' + file;
    try {
      if ((await stat(join(store, path))).isFile()) art[file] = contentRoot + 'public/gallery/' + file;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return art;
}
