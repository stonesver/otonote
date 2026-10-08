// Shared across previews; cancelling a model does not invalidate a reusable runtime.
let corePromise;
// Live2D publishes this endpoint specifically for hosted Web Core use.
export const OFFICIAL_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    const fail = message => { clearTimeout(timer); script.remove(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('Cubism Core timed out'), 30_000);
    script.onload = () => {
      if (!globalThis.Live2DCubismCore) { fail('Cubism Core did not initialize'); return; }
      clearTimeout(timer); resolve();
    };
    script.onerror = () => fail('Cubism Core could not load');
    document.head.append(script);
  });
}

export function loadLive2DCore(coreUrl) {
  if (globalThis.Live2DCubismCore) return Promise.resolve();
  corePromise ??= loadScript(coreUrl).catch(error => {
    if (coreUrl === OFFICIAL_CORE_URL) throw error;
    return loadScript(OFFICIAL_CORE_URL);
  }).catch(error => { corePromise = null; throw error; });
  return corePromise;
}
