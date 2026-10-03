// Development-only image producer, bundled by costume_poster_server.py.
// No imports from this module belong in the public costume listing.
import {loadLive2DPreview} from '../site/src/lib/live2d-loading.mjs';

const button = document.querySelector('button');
const status = document.querySelector('[role=status]');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const jobs = await (await fetch('/jobs')).json();
    let completed = 0;
    for (const job of jobs.rows) {
      const controller = new AbortController();
      let player;
      try {
        const {resources, createLive2DPlayer} = await loadLive2DPreview(new URL(job.root, location.origin).href, '/core.js', {
          signal:controller.signal, onProgress:p => { status.textContent = `${completed}/${jobs.rows.length} · ${job.groupId} · ${p.total ? Math.round(p.loaded/p.total*100)+'%' : '加载资源'}`; }
        });
        player = await createLive2DPlayer({canvas:document.querySelector('canvas'), resources, coreUrl:'/core.js', signal:controller.signal});
        for (const effect of ['blink','breath','gaze','physics']) player.effect(effect, false);
        player.resetParameters();
        if (job.presentation === 'instrument-off') {
          const parameter = player.parameters.find(p => p.id === 'ParamInstrumentOff');
          if (!parameter || parameter.max <= 0) throw new Error('Model has no instrument visibility control');
          // The game's switch displays instruments at 1 and hides them at 0.
          player.lock(parameter.index, parameter.min);
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const blob = await (await fetch(player.snapshot())).blob();
        const response = await fetch(`/result/${job.groupId}`, {method:'POST', headers:{'X-Poster-Token':jobs.token,'Content-Type':'image/png'}, body:blob});
        if (!response.ok) throw new Error(`保存图片失败 ${response.status}`);
        completed++;
      } finally {
        controller.abort(); player?.dispose();
        const old = document.querySelector('canvas'); old.replaceWith(document.createElement('canvas'));
      }
    }
    status.textContent = `完成 ${completed} 张全身图片`;
  } catch (error) { status.textContent = `生成失败：${error.message}；点击继续可复用已完成图片。`; }
  finally { button.disabled = false; }
});
