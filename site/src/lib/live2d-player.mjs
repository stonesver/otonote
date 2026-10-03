import { abortError } from './live2d-resources.mjs';
import { loadLive2DCore } from './live2d-core.mjs';

let runtimePromise;
export function prepareLive2DPlayer(coreUrl) {
  runtimePromise ??= (async () => {
    await loadLive2DCore(coreUrl);
    const [PIXI, cubism] = await Promise.all([import('pixi.js'), import('pixi-live2d-display/cubism4')]);
    cubism.config.preserveExpressionOnMotion = true;
    return { PIXI, ...cubism };
  })().catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}

export async function createLive2DPlayer({ canvas, resources, coreUrl, signal, onStats, onMotionEnd, onError }) {
  const { PIXI, Live2DModel, Cubism4ModelSettings } = await prepareLive2DPlayer(coreUrl);
  signal.throwIfAborted();
  const urls = new Map();
  let app, model, observer, setupPending = false;
  const events = new AbortController();
  const locks = new Map(), partLocks = new Map();
  const effects = { blink: true, breath: true, gaze: true, physics: true };
  let zoom = 1, pan = { x: 0, y: 0 }, drag, closed = false, sample = 0, frames = 0, frameStart = performance.now();
  const destroyModel = () => {
    if (!model) return;
    if (model.internalModel && model.automator) model.destroy({ children: true, texture: true, baseTexture: true });
    else {
      model.emit('destroy');
      model.textures?.forEach(texture => texture.destroy(true));
      model.internalModel?.destroy(); model.automator?.destroy();
      PIXI.Container.prototype.destroy.call(model, { children: true });
    }
    model = null;
  };
  const dispose = () => {
    if (closed) return;
    closed = true; events.abort(); observer?.disconnect();
    signal.removeEventListener('abort', dispose);
    if (app && model) app.stage.removeChild(model);
    if (!setupPending) destroyModel();
    app?.destroy(false, { children: true, texture: true, baseTexture: true });
    for (const url of urls.values()) URL.revokeObjectURL(url);
  };
  try {
    for (const [file, blob] of resources.blobs) urls.set(file, URL.createObjectURL(blob));
    const json = JSON.parse(await resources.blobs.get(resources.manifest.model).text());
    json.url = new URL(resources.manifest.model, location.href).href;
    const settings = new Cubism4ModelSettings(json);
    settings.resolveURL = path => {
      const url = urls.get(path);
      if (!url) throw new Error(`Unlisted model resource: ${path}`);
      return url;
    };
    // Construct explicitly so a partially initialized model can also be destroyed on failure.
    model = new Live2DModel({ autoUpdate: false, autoFocus: false, autoHitTest: false });
    const { Live2DFactory } = await import('pixi-live2d-display/cubism4');
    let optionalError;
    model.on('physicsLoadError', error => { optionalError = error; });
    setupPending = true;
    const pending = Live2DFactory.setupLive2DModel(model, settings, {
      autoUpdate: false, autoFocus: false, autoHitTest: false, motionPreload: 'NONE', idleMotionGroup: '__manual__', checkMocConsistency: true
    });
    const settled = () => { setupPending = false; if (closed) destroyModel(); };
    pending.then(settled, settled);
    let timer, onAbort;
    try {
      await Promise.race([pending, new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => reject(new Error('Model initialization timed out')), 30_000);
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    signal.throwIfAborted();
    if (optionalError) throw optionalError;
    app = new PIXI.Application({ view: canvas, width: 1, height: 1, autoDensity: true,
      resolution: Math.min(devicePixelRatio || 1, 2), backgroundAlpha: 0, antialias: true });
    app.ticker.maxFPS = 60;
    app.stage.addChild(model);
    const internal = model.internalModel, core = internal.coreModel;
    const parameterIds = core._model.parameters.ids;
    const parameters = parameterIds.map((id, index) => ({ id, index, min: core.getParameterMinimumValue(index),
      max: core.getParameterMaximumValue(index), default: resources.manifest.defaults[id] ?? core.getParameterDefaultValue(index) }));
    const parts = Array.from({ length: core.getPartCount() }, (_, index) => ({ id: String(core._model.parts.ids[index]),
      index, default: core.getPartOpacityByIndex(index) }));
    const resetParameters = () => {
      locks.clear(); partLocks.clear();
      internal.motionManager.stopAllMotions();
      internal.motionManager.expressionManager?.resetExpression();
      for (const p of parameters) core.setParameterValueByIndex(p.index, p.default);
      for (const p of parts) core.setPartOpacityByIndex(p.index, p.default);
      core.saveParameters();
    };
    resetParameters();
    const automatic = { blink: internal.eyeBlink, breath: internal.breath, physics: internal.physics };
    const originalFocus = internal.updateFocus.bind(internal);
    internal.updateFocus = () => { if (effects.gaze && !drag) originalFocus(); };
    const currentValues = new Float32Array(parameters.length);
    internal.on('beforeModelUpdate', () => {
      for (const [index, value] of locks) core.setParameterValueByIndex(index, value);
      for (const [index, value] of partLocks) core.setPartOpacityByIndex(index, value);
      for (let i = 0; i < parameters.length; i++) currentValues[i] = core.getParameterValueByIndex(i);
    });
    internal.motionManager.on('motionFinish', () => onMotionEnd?.());
    const fit = () => {
      const host = canvas.parentElement;
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      app.renderer.resize(width, height);
      const scale = Math.min(width * .9 / internal.originalWidth, height * .94 / internal.originalHeight) * zoom;
      model.scale.set(scale); model.anchor.set(.5, .5);
      model.position.set(width / 2 + pan.x, height / 2 + pan.y);
    };
    observer = new ResizeObserver(fit); observer.observe(canvas.parentElement); fit();
    const setZoom = value => { zoom = Math.max(.3, Math.min(4, value)); fit(); return zoom; };
    canvas.addEventListener('pointerdown', event => {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...pan } };
      canvas.setPointerCapture(event.pointerId);
    }, { signal: events.signal });
    canvas.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) {
        pan = { x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }; fit();
      } else if (effects.gaze) model.focus(event.clientX - canvas.getBoundingClientRect().left, event.clientY - canvas.getBoundingClientRect().top);
    }, { signal: events.signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      canvas.addEventListener(type, () => { drag = null; }, { signal: events.signal });
    canvas.addEventListener('wheel', event => { event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * .001)); },
      { passive: false, signal: events.signal });
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); onError?.(new Error('WebGL context lost')); }, { signal: events.signal });
    const tick = () => {
      if (document.hidden || closed) return;
      model.update(Math.min(app.ticker.deltaMS, 50));
      frames++;
      const now = performance.now();
      if (now - sample >= 120) {
        onStats?.({ fps: Math.round(frames * 1000 / (now - frameStart)), values: currentValues });
        sample = now;
        if (now - frameStart > 1000) { frames = 0; frameStart = now; }
      }
    };
    app.ticker.add(tick);
    model.update(0); app.renderer.render(app.stage);
    await new Promise(resolve => requestAnimationFrame(resolve));
    signal.throwIfAborted();
    signal.addEventListener('abort', dispose, { once: true });
    return {
      parameters, parts, dispose,
      snapshot() { app.renderer.render(app.stage); return app.renderer.extract.canvas(app.stage).toDataURL('image/png'); },
      play: (group, index) => model.motion(group, index, 3),
      stop: () => { internal.motionManager.stopAllMotions(); },
      expression: name => name ? model.expression(name) : Promise.resolve(internal.motionManager.expressionManager?.resetExpression()),
      lock(index, value) { if (value == null) locks.delete(index); else locks.set(index, value); },
      part(index, value) { partLocks.set(index, value); },
      resetParameters,
      resetView() { zoom = 1; pan = { x: 0, y: 0 }; fit(); },
      zoomBy(factor) { setZoom(zoom * factor); },
      effect(name, enabled) {
        effects[name] = enabled;
        const property = { blink: 'eyeBlink', breath: 'breath', physics: 'physics' }[name];
        if (property) internal[property] = enabled ? automatic[name] : undefined;
        if (name === 'gaze' && !enabled) { internal.focusController.x = 0; internal.focusController.y = 0; }
      }
    };
  } catch (error) { dispose(); throw signal.aborted ? abortError() : error; }
}
