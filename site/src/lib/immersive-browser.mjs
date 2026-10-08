import { EXPORT_SIZE, posterPng, webmMimeType } from './immersive-export.mjs';
import { beginExport, recordDownload } from './site-analytics.mjs';
import { loadImmersivePreview } from './immersive-loading.mjs';

export function initImmersiveScenes() {
  document.querySelectorAll('[data-immersive]').forEach(root => {
    if (root.dataset.initialized) return;
    root.dataset.initialized = 'true';
    const en = root.dataset.locale === 'en', compact = root.dataset.compact === 'true';
    if (root.dataset.cameraVerified !== 'true') {
      const button = root.querySelector('[data-scene-export="png"]');
      if (!button) return;
      const status = root.querySelector('[data-scene-status]');
      const download = root.querySelector('[data-scene-download]');
      const preview = root.querySelector('[data-export-preview]');
      let objectURL, busy = false;
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true; button.disabled = true; download.hidden = true;
        status.textContent = en ? 'Preparing the original image…' : '正在准备游戏原图…';
        const resource = `scene:${root.dataset.sceneId}:poster-png`;
        const exportEvent = beginExport(resource);
        try {
          const { blob, size } = await posterPng(root.dataset.posterSrc);
          exportEvent.finish('success'); recordDownload(resource);
          if (objectURL) URL.revokeObjectURL(objectURL);
          objectURL = URL.createObjectURL(blob);
          download.href = objectURL;
          download.download = `otonote-scene-${root.dataset.sceneId}-original-${size.width}x${size.height}.png`;
          download.dataset.analyticsResource = resource;
          if (preview) {
            const image = document.createElement('img'); image.src = objectURL;
            image.alt = en ? 'Original game scene' : '游戏原图';
            root.querySelector('[data-export-media]').replaceChildren(image);
            preview.hidden = false;
          }
          download.hidden = false; download.click();
          status.textContent = en ? `Original PNG ready · ${size.width} × ${size.height}` : `游戏原图 PNG 已生成 · ${size.width} × ${size.height}`;
        } catch (error) {
          exportEvent.finish('failed');
          status.textContent = en ? 'Could not save the original image. Please try again.' : '游戏原图保存失败，请重试。';
        } finally { busy = false; button.disabled = false; }
      });
      addEventListener('pagehide', () => { if (objectURL) URL.revokeObjectURL(objectURL); }, { once: true });
      return;
    }
    let duration = Number(root.dataset.duration) || 4;
    const say = (zh, english) => en ? english : zh;
    const find = selector => root.querySelector(selector);
    const load = find('[data-scene-load]'), play = find('[data-scene-play]'), status = find('[data-scene-status]');
    const timeline = find('[data-scene-time]'), clock = find('[data-scene-clock]'), cancel = find('[data-scene-cancel]');
    const controls = find('[data-scene-controls]'), download = find('[data-scene-download]');
    const loadProgress = find('[data-load-progress]'), loadBar = find('[data-load-bar]');
    const loadStage = find('[data-load-stage]'), loadPercent = find('[data-load-percent]'), loadBytes = find('[data-load-bytes]');
    function showLoadProgress({ phase, loaded = 0, total = 0 }) {
      if (disposed) return;
      loadProgress.hidden = false;
      const labels = { prepare: say('准备场景', 'Preparing scene'), download: say('下载场景资源', 'Downloading scene'),
        initialize: say('生成画面', 'Preparing the first frame'), ready: say('加载完成', 'Scene ready') };
      const label = labels[phase];
      if (loadStage.textContent !== label) loadStage.textContent = label;
      // Byte-driven download occupies 90%; the first rendered frame completes loading.
      const percent = phase === 'ready' ? 100 : phase === 'initialize' ? 90
        : phase === 'download' && total > 0 ? Math.min(90, Math.floor(loaded / total * 90)) : null;
      if (percent === null) loadBar.removeAttribute('value'); else loadBar.value = percent;
      loadPercent.textContent = percent === null ? '' : `${percent}%`;
      loadBar.setAttribute('aria-valuetext', percent === null ? label : `${label} · ${percent}%`);
      loadBytes.textContent = phase === 'download' && total > 0
        ? `${(loaded / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB` : '';
    }
    const progressPanel = find('[data-export-progress]'), progressBar = find('[data-export-bar]');
    const progressLabel = find('[data-export-stage]'), progressPercent = find('[data-export-percent]');
    function showProgress(value, label) {
      if (!progressPanel) return;
      const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
      progressPanel.hidden = false; progressBar.value = percent;
      progressLabel.textContent = label; progressPercent.textContent = `${percent}%`;
      progressBar.setAttribute('aria-valuetext', `${label} · ${percent}%`);
    }
    const exportButtons = [...root.querySelectorAll('[data-scene-export]')];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let viewer, loading = false, paused = true, busy = false, objectURL, controller, disposed = false;
    const pause = value => { paused = value; viewer?.setPaused(value); play.textContent = value ? say('播放', 'Play') : say('暂停', 'Pause'); play.setAttribute('aria-pressed', String(!value)); };
    const updateExportButtons = () => exportButtons.forEach(button => {
      const unavailable = button.dataset.sceneExport === 'webm' && !webmMimeType();
      button.disabled = !viewer || busy || unavailable;
      if (unavailable) button.title = say('当前浏览器不支持 WebM 导出，请使用 Chrome 或 Edge。', 'WebM export is unavailable. Try Chrome or Edge.');
    });
    function broken() {
      root.dataset.state = 'error'; controls.hidden = true; viewer?.dispose(); viewer = null;
      load.disabled = false; load.textContent = say('重新载入场景', 'Reload scene'); updateExportButtons();
      status.textContent = say('场景显示已中断，请重新载入。', 'The scene was interrupted. Please reload it.');
    }
    load.addEventListener('click', async () => {
      if (loading) return;
      loading = true; load.disabled = true; load.textContent = say('正在载入…', 'Loading…');
      root.dataset.state = 'loading'; status.textContent = say('正在载入场景，请稍候。', 'Loading the scene.');
      controller = new AbortController();
      root.setAttribute('aria-busy', 'true'); showLoadProgress({ phase: 'prepare' });
      try {
        const { resources, createImmersiveScene } = await loadImmersivePreview(root.dataset.assets, {
          signal: controller.signal, onProgress: showLoadProgress
        });
        if (resources.manifest?.approximateCamera !== false) throw new Error('camera-not-verified');
        if (disposed) return;
        showLoadProgress({ phase: 'initialize' });
        // Paint the final preparation stage before synchronous WebGL/Spine work.
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.signal.throwIfAborted();
        viewer = await createImmersiveScene(find('[data-scene-canvas]'), resources, {
          signal: controller.signal, onError: broken,
          onTime(time) { if (timeline) timeline.value = String(time); if (clock) clock.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} s`; }
        });
        if (disposed) { viewer.dispose(); return; }
        duration = viewer.duration; if (timeline) timeline.max = String(duration);
        const quality = find('[data-png-quality]');
        if (quality) quality.textContent = `PNG ${viewer.pngSize.width} × ${viewer.pngSize.height} · WebM 1920 × 1080`;
        showLoadProgress({ phase: 'ready' });
        root.dataset.state = 'ready'; controls.hidden = false; updateExportButtons();
        pause(reduced.matches); status.textContent = reduced.matches ? say('已按减少动态效果设置暂停，可手动播放。', 'Paused for reduced motion. You can play manually.') : '';
        if (!compact && !webmMimeType()) status.textContent = say('可下载 PNG；当前浏览器不支持 WebM 导出。', 'PNG is available. This browser cannot export WebM.');
      } catch (error) {
        if (disposed) return;
        if (error.name === 'AbortError') {
          root.dataset.state = 'idle'; load.disabled = false;
          load.textContent = say('播放动态场景', 'Play the scene'); status.textContent = '';
          return;
        }
        console.error('Immersive scene could not load', error);
        root.dataset.state = 'error'; load.disabled = false; load.textContent = say('重试载入', 'Try again');
        status.textContent = say('场景载入失败。请检查网络及浏览器图形加速，然后重试。', 'Could not load the scene. Check your connection and browser graphics support, then try again.');
      } finally { loading = false; loadProgress.hidden = true; root.removeAttribute('aria-busy'); }
    });
    play.addEventListener('click', () => pause(!paused));
    timeline?.addEventListener('input', () => { pause(true); viewer.seek(Number(timeline.value)); });
    find('[data-scene-layer]')?.addEventListener('change', event => viewer.setLayer(event.target.value));
    find('[data-scene-reset]')?.addEventListener('click', () => viewer.reset());
    root.querySelectorAll('[data-scene-zoom]').forEach(button => button.addEventListener('click', () => viewer.zoom(Number(button.dataset.sceneZoom))));
    reduced.addEventListener('change', event => { if (event.matches) pause(true); });
    for (const button of exportButtons) button.addEventListener('click', async () => {
      if (!viewer || busy) return;
      busy = true; updateExportButtons();
      const format = button.dataset.sceneExport;
      const analyticsResource = `scene:${root.dataset.sceneId}:${format}`;
      const exportEvent = beginExport(analyticsResource);
      recordDownload(analyticsResource);
      controls.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
      cancel.hidden = false; download.hidden = true;
      root.setAttribute('aria-busy', 'true');
      const size = format === 'png' ? viewer.pngSize : EXPORT_SIZE;
      showProgress(0, say('准备导出', 'Preparing export'));
      status.textContent = say('正在导出，请保持此页面可见…', 'Exporting. Keep this page visible…');
      try {
        const blob = format === 'png' ? await viewer.png((value, stage) => {
          const labels = { render: say('渲染高清画面', 'Rendering image'), encode: say('编码 PNG', 'Encoding PNG'), save: say('准备下载', 'Preparing download') };
          showProgress(value, labels[stage]);
        }) : await viewer.webm(progress => {
          showProgress(progress * .95, progress < 1 ? say('录制动画', 'Recording animation') : say('封装 WebM', 'Encoding WebM'));
          status.textContent = say('正在导出动画 · 切换页面将取消', 'Exporting animation · Switching tabs cancels');
        });
        if (disposed) { exportEvent.finish('cancelled'); return; }
        exportEvent.finish('success');
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = URL.createObjectURL(blob);
        download.href = objectURL; download.download = `otonote-scene-${root.dataset.sceneId}-${viewer.layer}-${size.width}x${size.height}.${format}`;
        download.dataset.analyticsResource = analyticsResource;
        const preview = find('[data-export-preview]'), media = document.createElement(format === 'png' ? 'img' : 'video');
        media.src = objectURL;
        if (format === 'png') media.alt = say('导出的场景画面', 'Exported scene');
        else { media.controls = true; media.loop = true; media.playsInline = true; media.preload = 'metadata'; }
        find('[data-export-media]').replaceChildren(media); preview.hidden = false;
        download.hidden = false; download.click();
        showProgress(1, say('文件已生成', 'File ready'));
        status.textContent = say(`已导出 ${format.toUpperCase()} · ${size.width} × ${size.height} · ${(blob.size / 1024 / 1024).toFixed(2)} MB`, `Exported ${format.toUpperCase()} · ${size.width} × ${size.height} · ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      } catch (error) {
        exportEvent.finish(error.name === 'AbortError' ? 'cancelled' : 'failed');
        progressPanel.hidden = true;
        status.textContent = error.name === 'AbortError'
          ? say('导出已取消，可以重新开始。', 'Export cancelled. You can start again.')
          : say('导出失败，请重试或尝试较新的 Chrome / Edge。', 'Export failed. Try again or use a recent Chrome / Edge.');
      } finally {
        busy = false; cancel.hidden = true; root.removeAttribute('aria-busy'); updateExportButtons();
        controls.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; });
      }
    });
    cancel?.addEventListener('click', () => viewer?.cancelExport());
    addEventListener('pagehide', event => {
      if (event.persisted) { if (loading) controller?.abort(); viewer?.cancelExport(); pause(true); return; }
      disposed = true; controller?.abort(); viewer?.dispose(); if (objectURL) URL.revokeObjectURL(objectURL);
    });
  });
}
