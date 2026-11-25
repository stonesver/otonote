// Runs inline in the head so even a cold page registers before its first reveal.
(() => {
  const root = document.documentElement;
  let revealGeneration = 0;
  const domReady = document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();

  const waitWithin = async (promise, milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise).then(() => true, () => true),
        new Promise(resolve => { timer = window.setTimeout(() => resolve(false), milliseconds); })
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  };

  window.addEventListener('pagereveal', async event => {
    if (!event.viewTransition || root.dataset.motion === 'off' ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // The incoming snapshot is live. Hold the old frame at animation time zero
    // while deferred components finish their first layout, then lift the curtain.
    root.dataset.navigationPending = 'true';
    const generation = ++revealGeneration;
    let finished = false;
    const release = () => {
      if (generation === revealGeneration) delete root.dataset.navigationPending;
    };
    const onFinished = () => { finished = true; release(); };
    event.viewTransition.finished.then(onFinished, onFinished);
    try {
      if (!await waitWithin(domReady, 400)) return;
      if (finished || generation !== revealGeneration) return;
      const images = [...document.querySelectorAll('main img')].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0 &&
          rect.left < window.innerWidth && rect.right > 0 && !!(image.currentSrc || image.getAttribute('src'));
      }).slice(0, 6);
      await waitWithin(Promise.allSettled(images.map(image => {
        image.loading = 'eager';
        return image.decode();
      })), 150);
    } catch {
      // Readiness is an enhancement; retain native navigation if it cannot be measured.
    } finally {
      // A failed/slow component or image must never leave the transition paused.
      release();
    }
  });
})();
