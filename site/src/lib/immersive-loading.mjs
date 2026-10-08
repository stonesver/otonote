import { readResource } from './live2d-resources.mjs';

// The scene describes dependencies; the manifest supplies decoded byte sizes.
// Download only the files needed for playback (not posters or export artifacts).
export async function loadImmersiveAssets(root, { signal, onProgress = () => {}, fetcher = fetch } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const read = file => readResource(`${root}${file}`, { signal: controller.signal, fetcher });
  try {
    onProgress({ phase: 'prepare' });
    const [sceneBlob, manifestBlob] = await Promise.all([read('scene.json'), read('manifest.json')]);
    const data = JSON.parse(await sceneBlob.text()), manifest = JSON.parse(await manifestBlob.text());
    controller.signal.throwIfAborted();
    const textures = data.textures ?? { background: 'background.webp', characters: 'characters.webp' };
    const atlases = data.atlases ?? { default: { file: 'characters.atlas', pages: { 'characters.webp': 'characters' } } };
    const names = new Set([...Object.values(textures), ...Object.values(atlases).map(entry => entry.file),
      ...data.nodes.filter(node => node.spine).map(node => `${node.spine}.${node.spineFormat === 'binary' ? 'skel' : 'json'}`)]);
    const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
    const jobs = [...names].map(file => {
      const entry = entries.get(file);
      if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
          typeof file !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith('/') ||
          (file.split('/').includes('..') && !/^\.\.\/shared\/[a-zA-Z0-9_.-]+$/.test(file)))
        throw new Error(`Invalid scene resource: ${file}`);
      return entry;
    }).sort((a, b) => b.bytes - a.bytes);
    const total = jobs.reduce((sum, entry) => sum + entry.bytes, 0);
    const blobs = new Map(), loaded = new Map();
    let cursor = 0;
    const progress = () => {
      if (!controller.signal.aborted) onProgress({ phase: 'download', total,
        loaded: [...loaded.values()].reduce((sum, value) => sum + value, 0) });
    };
    progress();
    const worker = async () => {
      while (cursor < jobs.length) {
        controller.signal.throwIfAborted();
        const entry = jobs[cursor++];
        const blob = await readResource(`${root}${entry.path}`, { signal: controller.signal, fetcher,
          expectedBytes: entry.bytes, onBytes(bytes) { loaded.set(entry.path, bytes); progress(); } });
        controller.signal.throwIfAborted();
        blobs.set(entry.path, blob);
      }
    };
    // Wait for cancellation/cleanup of every worker before releasing this load.
    await Promise.allSettled(Array.from({ length: Math.min(4, jobs.length) }, () => worker().catch(error => {
      controller.abort(error); throw error;
    })));
    controller.signal.throwIfAborted();
    return { data, manifest, blobs };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); }
}

export async function loadImmersivePreview(root, { signal, onProgress,
  loadAssets = loadImmersiveAssets, loadRenderer = () => import('./immersive-renderer.mjs') } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    const ready = Promise.all([
      Promise.resolve().then(() => loadAssets(root, { signal: controller.signal, onProgress })),
      Promise.resolve().then(loadRenderer),
    ]);
    const [resources, renderer] = await Promise.race([ready, aborted]);
    controller.signal.throwIfAborted();
    return { resources, createImmersiveScene: renderer.createImmersiveScene };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
