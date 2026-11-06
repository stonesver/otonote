import { createAutoStageFrame } from './auto-stage-layout.mjs';
import { normalizeAutoTimeline } from './auto-timeline.mjs';
import { createAutoScene } from './auto-stage-scene.mjs';
import { loadGameSkin } from './auto-stage-skin.mjs';
import { createAutoStageRenderer } from './auto-stage-renderer.ts';
import { createDemoClock } from './demo-clock.mjs';
import { createMediaClock } from './media-clock.mjs';
import { chartLoopRange, chartPlaybackFromSearch, chartPlaybackUrl } from './chart-playback-state.mjs';
import { createTimingPlayback, importTimingPlayback, timingPlaybackDuration } from './ap-timing-playback.mjs';
import { SCORE_DIFFICULTY_REQUEST_EVENT, SCORE_DIFFICULTY_CHANGE_EVENT } from './score-workbench-element.ts';

const formatTime = time => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };

export function registerChartDemo() {
  if (customElements.get('auto-stage')) return;
  customElements.define('auto-stage', class extends HTMLElement {
    connectedCallback() {
      this.cleanup?.();
      const en = this.dataset.locale === 'en';
      const find = name => this.querySelector(`[data-auto-${name}]`);
      const canvas = find('canvas'), context = canvas.getContext('2d');
      const play = find('play'), reset = find('reset'), seek = find('seek'), difficulty = find('difficulty');
      const status = find('status'), retry = find('retry'), skinStatus = find('skin-status');
      if (!context) { status.textContent = en ? 'Canvas is unavailable.' : '当前浏览器不支持 Canvas。'; return; }
      const { skin, missions } = JSON.parse(find('config').textContent);
      const audio = find('audio');
      if (audio) audio.volume = Number(find('volume').value);
      const clock = audio ? createMediaClock(audio) : createDemoClock();
      const events = new AbortController(), images = new Map();
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
      const profile = { mode: 'full', effects: !reducedMotion.matches, laneGuides: true };
      find('effects').checked = profile.effects;
      let request, sequence = 0, timeline, frameId = 0, disposed = false, playbackDuration = 0, playAttempt = 0;
      let skinRequest = null, skinLoaded = false, firstLoad = true, loadedDifficulty = null, size = null;
      let loopStart = null, loopEnd = null, loopRestartPending = false;
      let rawChart=null,timing=null,timingFile=null;
      const loopRange = () => chartLoopRange(loopStart, loopEnd, playbackDuration);
      const activeLoop = () => find('loop-enabled').checked ? loopRange() : null;
      const syncLoop = () => {
        const range = loopRange();
        find('loop-enabled').disabled = !range;
        if (!range) find('loop-enabled').checked = false;
        find('loop-clear').disabled = loopStart == null && loopEnd == null;
        find('loop-range').textContent = loopStart == null && loopEnd == null
          ? (en ? 'Choose a start and end' : '选择区段起点和终点')
          : `A ${loopStart == null ? '—' : loopStart.toFixed(2)}s → B ${loopEnd == null ? '—' : loopEnd.toFixed(2)}s`;
      };
      const readyStatus = () => audio ? (en ? 'Music synced · auto play' : '歌曲音频同步 · 自动演奏') : (en ? 'Silent chart playback' : '无歌曲音频 · 自动演奏');
      const renderer = createAutoStageRenderer({ images, comboSkin: skin.comboSkin, onSkinStateChange() {}, labels: { cssStage: '', realBackground: '', realLane: '', realNotes: '', formalArrows: '', staticEffects: '' } });
      const sync = () => {
        const time = clock.time();
        seek.value = String(time);
        setText(find('time'), `${formatTime(time)} / ${formatTime(playbackDuration)}`);
        setText(play, clock.playing ? (en ? 'Pause' : '暂停') : (en ? 'Play' : '播放'));
        play.setAttribute('aria-pressed', String(clock.playing));
      };
      const draw = () => {
        const rect = size ?? canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const scale = Math.min(devicePixelRatio || 1, 2);
        const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.setTransform(scale, 0, 0, scale, 0, 0);
        const frame = createAutoStageFrame({ width: rect.width, height: rect.height }, {
          gutter: Math.max(rect.width * 0.06, (rect.width - rect.height * 1.85) / 2),
          topWidthRatio: 0.12, horizonRatio: 0.08, judgementRatio: 0.88, perspective: true
        });
        const scene = timeline ? createAutoScene(timeline, frame, clock.time(), { lookAheadSeconds: 2.5 / Number(find('speed').value), missions, en, performance:timing })
          : { longPaths: [], markers: [], hitEffects: [], activeCue: null, combo: 0 };
        renderer.render({ context, frame, profile, stageTheme: skin.theme,
          gameSettings: { backgroundBrightness: Number(find('brightness').value), laneOpacity: 78, guidelineOpacity: 50, slideOpacity: 75, guideOpacity: 55,
            hiddenHeight: Number(find('hidden-height').value), hiddenFade: Number(find('hidden-fade').value) }, scene });
        setText(find('combo'), String(scene.combo));
        if(find('timing-status')&&timing)setText(find('timing-status'),`${timing.variant.timingCondition.frameRate} FPS · ${en?'Calculated playback · Score':'计算方案回放 · 得分'} ${Math.round(scene.score??0).toLocaleString()} · ${(scene.scoreUpFactor??1).toFixed(2)}×`);
        setText(find('section'), scene.activeGekisou ? `${en ? 'Section' : '激奏'} ${scene.activeGekisou.index} · ${scene.activeGekisou.label}` : (en ? 'Normal section' : '常规区间'));
        sync();
      };
      const ensureSkin = async () => {
        if (skinLoaded || disposed) return;
        if (skinRequest) return skinRequest;
        skinRequest = loadGameSkin(skin, images, { onProgress: (done, total) => {
          if (!disposed) setText(skinStatus, `${en ? 'Loading skin' : '加载皮肤'} ${done}/${total}`);
        } }).then(result => {
          if (disposed) return;
          skinLoaded = result.loaded === result.total;
          setText(skinStatus, skinLoaded ? (en ? 'Game skin 01' : '游戏皮肤 01') : (en ? 'Partial skin · retry' : '部分皮肤未载入'));
          if (!skinLoaded) retry.hidden = false;
          draw();
        }).finally(() => { skinRequest = null; });
        return skinRequest;
      };
      const persistPosition = () => {
        if (!timeline) return;
        const url = chartPlaybackUrl(location.href, { time: clock.time(), difficulty: difficulty.value, loop: activeLoop() });
        history.replaceState(null, '', url);
      };
      const restartLoop = async () => {
        const range = activeLoop();
        if (!range || loopRestartPending) return;
        const attempt = playAttempt;
        loopRestartPending = true;
        clock.seek(range.start);
        try {
          await Promise.resolve(clock.play());
          if (disposed || attempt !== playAttempt) { clock.pause(); return; }
          if (!frameId) tick();
        } catch {
          if (!disposed && attempt === playAttempt) status.textContent = en ? 'Could not resume. Press Play to retry.' : '暂时无法继续播放，请点击播放重试。';
        } finally { loopRestartPending = false; }
      };
      const tick = () => {
        frameId = 0;
        const range = activeLoop();
        if (range && clock.time() >= range.end) {
          if (!clock.playing) { void restartLoop(); draw(); return; }
          clock.seek(range.start);
        }
        draw();
        if (clock.playing) frameId = requestAnimationFrame(tick);
        else if (timeline && clock.time() >= playbackDuration) setText(status, en ? 'Playback complete' : '演奏结束');
      };
      const stop = () => { playAttempt++; clock.pause(); cancelAnimationFrame(frameId); frameId = 0; play.disabled = !timeline; sync(); };
      const listen = (element, type, callback) => element.addEventListener(type, callback, { signal: events.signal });
      const resizeTimingClock=()=>{if(!timeline)return;const time=clock.time();stop();playbackDuration=Math.max(timeline.duration,Number(audio?.dataset.duration)||0,timingFile?timingPlaybackDuration(timeline,timingFile.skillPlayback):0);clock.load(playbackDuration);clock.seek(time);seek.max=String(playbackDuration);syncLoop();};
      const clearTiming=()=>{timing=null;timingFile=null;if(find('timing-file'))find('timing-file').value='';if(find('timing-variant'))find('timing-variant').replaceChildren();if(find('timing-controls'))find('timing-controls').hidden=true;if(find('timing-clear'))find('timing-clear').hidden=true;if(find('timing-status'))find('timing-status').textContent='';resizeTimingClock();};
      if(find('timing-file'))listen(find('timing-file'),'change',async()=>{
        const file=find('timing-file').files[0];if(!file||!rawChart)return;
        const currentChart=rawChart;
        try{
          const value=JSON.parse(await file.text());if(rawChart!==currentChart)return;
          timingFile=importTimingPlayback(value,rawChart);const select=find('timing-variant');select.replaceChildren();
          timingFile.skillPlayback.variants.forEach((v,i)=>{const option=document.createElement('option');option.value=String(i);const c=v.timingCondition;option.textContent=`${c.frameRate} FPS · ${c.kind==='ap_minimum'?(en?'AP minimum':'AP 最低分'):c.kind==='ap_maximum'?(en?'AP maximum':'AP 最高分'):c.kind==='alignment'?(en?'Favorable alignment':'有利对齐'):(en?'Reference clock':'参考时钟')} · ${Number(c.phaseMs.toFixed(3))} ms`;select.append(option);});
          timing=createTimingPlayback(timingFile.skillPlayback,timingFile.skillPlayback.variants[0]);find('timing-controls').hidden=false;find('timing-clear').hidden=false;resizeTimingClock();draw();
        }catch(error){clearTiming();find('timing-status').textContent=error.message;}
      });
      if(find('timing-variant'))listen(find('timing-variant'),'change',()=>{timing=createTimingPlayback(timingFile.skillPlayback,timingFile.skillPlayback.variants[Number(find('timing-variant').value)]);draw();});
      if(find('timing-clear'))listen(find('timing-clear'),'click',()=>{clearTiming();find('timing-file').value='';draw();});
      const load = async () => {
        const requestedPosition = firstLoad ? null : loadedDifficulty === difficulty.value
          ? { time: clock.time(), loop: activeLoop() } : null;
        if (!firstLoad && loadedDifficulty !== difficulty.value) {
          const url = new URL(location.href);
          for (const key of ['t', 'loopStart', 'loopEnd']) url.searchParams.delete(key);
          history.replaceState(history.state, '', url);
        }
        stop(); clearTiming();rawChart=null;timeline = undefined; playbackDuration = 0; clock.load(0); draw();
        request?.abort(); request = new AbortController();
        const current = ++sequence;
        play.disabled = reset.disabled = seek.disabled = true;
        for (const name of ['loop-start', 'loop-end', 'copy-position']) find(name).disabled = true;
        loopStart = loopEnd = null; syncLoop();
        retry.hidden = true;
        status.textContent = en ? 'Loading chart…' : '正在加载谱面…';
        try {
          const response = await fetch(difficulty.selectedOptions[0].dataset.url, { signal: request.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (disposed || current !== sequence) return;
          rawChart=data;timeline = normalizeAutoTimeline(data);
          playbackDuration = Math.max(timeline.duration, Number(audio?.dataset.duration) || 0);
          clock.load(playbackDuration); seek.max = String(playbackDuration);
          const requested = firstLoad ? chartPlaybackFromSearch(location.search, playbackDuration) : requestedPosition;
          if (requested) {
            clock.seek(requested.time);
            loopStart = requested.loop?.start ?? null;
            loopEnd = requested.loop?.end ?? null;
            find('loop-enabled').checked = Boolean(requested.loop);
          }
          firstLoad = false; loadedDifficulty = difficulty.value;
          play.disabled = reset.disabled = seek.disabled = false;
          for (const name of ['loop-start', 'loop-end', 'copy-position']) find(name).disabled = false;
          syncLoop();
          status.textContent = readyStatus();
          draw();
        } catch (error) {
          if (disposed || current !== sequence || error.name === 'AbortError') return;
          status.textContent = en ? 'Could not load chart. Retry to continue.' : '谱面加载失败，请重试。';
          retry.hidden = false;
        }
      };
      listen(play, 'click', async () => {
        if (clock.playing) { stop(); persistPosition(); return; }
        const attempt = ++playAttempt;
        play.disabled = true;
        void ensureSkin();
        try {
          const range = activeLoop();
          if (range && (clock.time() < range.start || clock.time() >= range.end)) clock.seek(range.start);
          await Promise.resolve(clock.play());
          if (disposed || attempt !== playAttempt) { clock.pause(); return; }
          status.textContent = readyStatus();
          if (!frameId) tick();
        } catch {
          if (disposed || attempt !== playAttempt) return;
          status.textContent = en ? 'Audio could not play. Please retry.' : '音频暂时无法播放，请重新加载。';
          retry.hidden = false;
          sync();
        } finally {
          if (attempt === playAttempt) play.disabled = !timeline;
        }
      });
      listen(reset, 'click', () => { stop(); clock.seek(0); persistPosition(); status.textContent = readyStatus(); draw(); });
      listen(seek, 'input', () => { clock.seek(seek.value); draw(); });
      listen(seek, 'change', persistPosition);
      for (const edge of ['start', 'end']) listen(find(`loop-${edge}`), 'click', () => {
        if (edge === 'start') loopStart = clock.time(); else loopEnd = clock.time();
        syncLoop(); persistPosition();
        if (loopStart != null && loopEnd != null && !loopRange()) status.textContent = en
          ? 'B must be at least 0.25 seconds after A.' : 'B 点需要比 A 点至少晚 0.25 秒。';
        else status.textContent = readyStatus();
      });
      listen(find('loop-enabled'), 'change', () => {
        const range = activeLoop();
        if (range && (clock.time() < range.start || clock.time() >= range.end)) clock.seek(range.start);
        persistPosition(); draw();
      });
      listen(find('loop-clear'), 'click', () => {
        loopStart = loopEnd = null; syncLoop(); persistPosition(); status.textContent = readyStatus();
      });
      listen(find('copy-position'), 'click', async () => {
        persistPosition();
        try {
          await navigator.clipboard.writeText(location.href);
          if (!disposed) status.textContent = en ? 'Position link copied, including difficulty and active loop.' : '已复制位置链接，包含难度与已启用的循环区段。';
        } catch {
          if (!disposed) status.textContent = en ? 'The address bar now contains this position. Copy its URL to share.' : '当前位置已更新到地址栏，可复制地址栏链接。';
        }
      });
      listen(find('rate'), 'change', event => { clock.setRate(event.target.value); draw(); });
      const setNoteSpeed = (value, formatNumber = true) => {
        const parsed = Number.parseFloat(value);
        const speed = Math.round(Math.min(4, Math.max(0.5, Number.isFinite(parsed) ? parsed : 1)) * 20) / 20;
        find('speed').value = String(speed);
        if (formatNumber) find('speed-number').value = speed.toFixed(2);
        draw();
      };
      listen(find('speed'), 'input', event => setNoteSpeed(event.target.value));
      listen(find('speed-number'), 'input', event => {
        const value = Number.parseFloat(event.target.value);
        if (value >= 0.5 && value <= 4) setNoteSpeed(value, false);
      });
      listen(find('speed-number'), 'change', event => setNoteSpeed(event.target.value));
      listen(find('brightness'), 'input', draw);
      for (const name of ['hidden-height', 'hidden-fade']) {
        listen(find(name), 'input', () => {
          const value = Number(find(name).value);
          const label = name === 'hidden-height' && value === 0 ? (en ? 'Off' : '关闭') : `${value}%`;
          setText(find(`${name}-value`), label);
          find(name).setAttribute('aria-valuetext', label);
          draw();
        });
      }
      listen(find('effects'), 'change', () => { profile.effects = find('effects').checked; draw(); });
      listen(reducedMotion, 'change', () => { profile.effects = !reducedMotion.matches; find('effects').checked = profile.effects; draw(); });
      listen(find('fullscreen'), 'click', async () => {
        try {
          if (document.fullscreenElement === this) await document.exitFullscreen();
          else await this.requestFullscreen();
        } catch { status.textContent = en ? 'Full screen is unavailable in this browser.' : '当前浏览器不支持全屏。'; }
      });
      listen(document, 'fullscreenchange', () => {
        setText(find('fullscreen'), document.fullscreenElement === this ? (en ? 'Exit full screen' : '退出全屏') : (en ? 'Full screen' : '全屏'));
      });
      listen(difficulty, 'change', () => {
        window.dispatchEvent(new CustomEvent(SCORE_DIFFICULTY_REQUEST_EVENT, { detail: { difficulty: difficulty.value } }));
        void load();
      });
      listen(window, SCORE_DIFFICULTY_CHANGE_EVENT, event => {
        const value = event.detail?.difficulty;
        if (value && value !== difficulty.value && [...difficulty.options].some(option => option.value === value)) {
          difficulty.value = value; void load();
        }
      });
      listen(window, 'song-detail-view-change', event => {
        if (event.detail.view !== 'playback') stop();
        else { persistPosition(); void ensureSkin(); requestAnimationFrame(draw); }
      });
      if (audio) {
        listen(find('volume'), 'input', event => { audio.volume = Number(event.target.value); });
        listen(audio, 'seeked', draw);
        listen(audio, 'loadedmetadata', draw);
        listen(audio, 'ended', () => {
          if (activeLoop()) { void restartLoop(); return; }
          stop(); draw(); status.textContent = en ? 'Playback complete' : '演奏结束';
        });
        listen(audio, 'waiting', () => { status.textContent = en ? 'Buffering audio…' : '音频缓冲中…'; });
        listen(audio, 'playing', () => { status.textContent = readyStatus(); });
        listen(audio, 'error', () => {
          stop(); status.textContent = en ? 'Could not load audio. Please retry.' : '音频加载失败，请重新加载。'; retry.hidden = false;
        });
      }
      listen(retry, 'click', () => { void ensureSkin(); audio?.load(); void load(); });
      listen(document, 'visibilitychange', () => { if (document.hidden) stop(); });
      const resize = new ResizeObserver(entries => { size = entries[0].contentRect; draw(); }); resize.observe(canvas);
      this.cleanup = () => { disposed = true; stop(); request?.abort(); events.abort(); resize.disconnect(); clock.destroy?.(); };
      const requested = new URLSearchParams(location.search).get('difficulty');
      if ([...difficulty.options].some(option => option.value === requested)) difficulty.value = requested;
      if (new URLSearchParams(location.search).get('view') === 'playback') void ensureSkin();
      void load();
    }
    disconnectedCallback() { this.cleanup?.(); }
  });
}
