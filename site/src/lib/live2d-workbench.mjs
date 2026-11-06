import { abortError } from './live2d-resources.mjs';
import { loadLive2DPreview } from './live2d-loading.mjs';
import { clipLabel, preferredMotion } from './live2d-labels.mjs';
import { beginExport } from './site-analytics.mjs';

import { ModelPicker } from './live2d-picker.mjs';

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
let instance = 0;

class Live2DWorkbench extends HTMLElement {
  connectedCallback() {
    if (this.connected) return;
    this.connected = true;
    this.config = JSON.parse(this.querySelector('[data-l2d-config]').textContent);
    this.uid = ++instance;
    this.events = new AbortController();
    this.rows = [];
    this.generation = 0;
    this.motionGeneration = 0;
    this.q = selector => this.querySelector(selector);
    this.say = (zh, en) => this.config.en ? en : zh;
    const listen = (selector, event, fn) => this.q(selector)?.addEventListener(event, fn, { signal: this.events.signal });
    const query = new URLSearchParams(location.search);
    const initial = String(this.config.characterId || query.get('character') || this.config.characters[0]?.id);
    const choices = this.config.models.filter(m => String(m.characterId) === initial);
    this.selectedModel = choices.find(m => m.id === query.get('costume')) || choices.find(m => m.isDefault && m.state === 'available')
      || choices.find(m => m.state === 'available') || this.config.models[0];
    this.picker = new ModelPicker(this, this.config, this.selectedModel, model => {
      this.selectedModel = model; this.changeSelection();
    }, this.events.signal);
    this.querySelectorAll('[data-panel-mode]').forEach(button => button.addEventListener('click', () => {
      const debug = button.dataset.panelMode === 'debug';
      this.q('[data-play-panel]').hidden = debug; this.q('[data-debug-panel]').hidden = !debug;
      this.querySelectorAll('[data-panel-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    }, { signal: this.events.signal }));
    listen('[data-open]', 'click', () => this.load());
    listen('[data-cancel]', 'click', () => this.close(true));
    listen('[data-close]', 'click', () => this.close());
    listen('[data-export]', 'click', () => this.exportSelected());
    listen('[data-export-cancel]', 'click', () => this.cancelExport(true));
    this.querySelectorAll('[data-background-choice]').forEach(button => button.addEventListener('click', () => {
      this.q('[data-stage]').dataset.background = button.dataset.backgroundChoice;
      this.querySelectorAll('[data-background-choice]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    }, { signal: this.events.signal }));
    listen('[data-minus]', 'click', () => this.player?.zoomBy(.8));
    listen('[data-plus]', 'click', () => this.player?.zoomBy(1.25));
    listen('[data-fit]', 'click', () => this.player?.resetView());
    listen('[data-play]', 'click', () => this.play());
    listen('[data-stop]', 'click', () => this.stop());
    listen('[data-motion]', 'change', () => this.stop());
    listen('[data-clip-search]', 'input', () => this.populateClips());
    listen('[data-expression]', 'change', async e => {
      const player = this.player, generation = this.generation;
      try {
        const result = await player?.expression(e.target.value);
        if (generation === this.generation && result === false) throw new Error(this.say('表情无法播放', 'Expression could not play'));
      } catch (error) { if (generation === this.generation) this.q('[data-playing]').textContent = error.message; }
    });
    this.querySelectorAll('[data-effect]').forEach(input => input.addEventListener('change', () => {
      this.player?.effect(input.dataset.effect, input.checked);
    }, { signal: this.events.signal }));
    listen('[data-search]', 'input', e => {
      const term = e.target.value.trim().toLowerCase();
      for (const row of this.rows) row.node.hidden = !row.id.toLowerCase().includes(term);
    });
    listen('[data-reset]', 'click', () => {
      this.stop(); this.player?.resetParameters();
      this.q('[data-expression]').value = '';
      for (const row of this.rows) row.lock.checked = false;
      for (const row of this.partRows || []) { row.slider.value = row.default; row.output.value = row.default.toFixed(2); }
    });
    window.addEventListener('pagehide', () => { this.close(); this.cancelExport(); }, { signal: this.events.signal });
    this.selectionInfo();
  }

  disconnectedCallback() { this.picker?.dispose(); this.close(); this.cancelExport(); this.events?.abort(); this.connected = false; }

  get selected() { return this.selectedModel; }

  selectionInfo() {
    const model = this.selected;
    const character = this.config.characters.find(c => c.id === model?.characterId);
    this.style.setProperty('--l2d-accent', character?.color || 'var(--theme-secondary)');
    this.q('[data-stage-name]').textContent = character?.name || '';
    this.q('[data-model-info]').textContent = model?.state === 'available'
      ? `${mb(model.bytes)} · ${model.motions} ${this.say('动作', 'motions')} · ${model.expressions} ${this.say('表情', 'expressions')}${model.blockedMotions ? ` · ${model.blockedMotions} ${this.say('动作未支持', 'unsupported motions')}` : ''}`
      : this.say('此服装尚无可用模型', 'No model available for this costume');
    this.q('[data-open]').disabled = model?.state !== 'available';
    this.q('[data-export]').disabled = model?.state !== 'available' || Boolean(this.exportController);
    this.q('[data-model-source]').textContent = model ? this.say('角色与服装来自国际服游戏内容。', 'Characters and costumes come from the Global game.') : '';
    this.q('[data-model-source]').removeAttribute('title');
    if (model?.state !== 'available') {
      this.q('[data-status]').textContent = model ? this.say('资源暂不可用', 'Resources unavailable') : this.say('没有匹配的模型', 'No matching models');
      this.q('[data-detail]').textContent = model?.error || this.say('请更换分类、搜索词或造型。', 'Try another category, search or variant.');
    }
  }

  changeSelection() {
    const wasOpen = Boolean(this.controller);
    this.cancelExport();
    this.close(); this.selectionInfo();
    if (!this.config.compact) {
      const url = new URL(location.href);
      for (const [key, value] of [['character', this.selected?.characterId], ['costume', this.selected?.id]]) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
      history.replaceState(null, '', url);
    }
    if (wasOpen && this.selected?.state === 'available') this.load();
  }

  cancelExport(cancelled = false) {
    this.exportController?.abort(abortError()); this.exportController = null;
    if (this.exportUrl) URL.revokeObjectURL(this.exportUrl);
    this.exportUrl = null;
    const save = this.q('[data-export-save]'); save.hidden = true; save.removeAttribute('href'); save.removeAttribute('download');
    this.q('[data-export]').disabled = this.selected?.state !== 'available';
    this.q('[data-export-cancel]').hidden = true;
    this.q('[data-export-progress]').hidden = true;
    this.q('[data-export-status]').textContent = cancelled ? this.say('已取消导出', 'Export cancelled') : this.say('运行时模型包 · 使用资源默认参数', 'Runtime model package · Source defaults');
  }

  async exportSelected() {
    if (this.exportController || this.selected?.state !== 'available') return;
    this.cancelExport();
    const selected = this.selected;
    const controller = this.exportController = new AbortController();
    const analyticsResource = `live2d:${selected.id}`;
    const exportEvent = beginExport(analyticsResource);
    controller.signal.addEventListener('abort', () => exportEvent.finish('cancelled'), { once: true });
    const { signal } = controller;
    const button = this.q('[data-export]'), progress = this.q('[data-export-progress]'), status = this.q('[data-export-status]');
    button.disabled = true; progress.hidden = false; progress.removeAttribute('value');
    this.q('[data-export-cancel]').hidden = false;
    status.textContent = this.say('正在准备导出…', 'Preparing export…');
    try {
      const { exportModel } = await import('./live2d-export.mjs');
      signal.throwIfAborted();
      const root = new URL(selected.root.startsWith('/content/') ? selected.root : this.config.base.replace(/\/$/, '') + selected.root, location.origin).href;
      const archive = await exportModel(root, { signal, onProgress: snapshot => {
        if (signal.aborted || this.exportController !== controller) return;
        const label = snapshot.phase === 'packing' ? this.say('正在打包', 'Packing') : this.say('正在下载资源', 'Downloading resources');
        if (snapshot.total) {
          progress.value = snapshot.loaded / snapshot.total * 100;
          status.textContent = `${label} · ${progress.value.toFixed(0)}% · ${mb(snapshot.loaded)} / ${mb(snapshot.total)}${snapshot.cached ? ` · ${this.say('缓存', 'cached')} ${mb(snapshot.cached)}` : ''}`;
        } else { progress.removeAttribute('value'); status.textContent = this.say('正在读取资源清单…', 'Reading resource manifest…'); }
      } });
      signal.throwIfAborted();
      if (this.exportController !== controller) return;
      this.exportUrl = URL.createObjectURL(archive);
      exportEvent.finish('success');
      const save = this.q('[data-export-save]');
      save.href = this.exportUrl;
      save.download = `${selected.modelPath.split('/').at(-1)}.zip`;
      save.dataset.analyticsResource = analyticsResource;
      save.hidden = false;
      progress.value = 100;
      status.textContent = this.say(`模型包已就绪 · ${mb(archive.size)}，点击“保存 ZIP”下载。`, `Package ready · ${mb(archive.size)}. Click “Save ZIP” to download.`);
    } catch (error) {
      exportEvent.finish(signal.aborted ? 'cancelled' : 'failed');
      if (signal.aborted || this.exportController !== controller) return;
      progress.hidden = true;
      status.textContent = `${this.say('导出失败，可重新点击导出重试', 'Export failed; click Export to retry')}：${error.message}`;
    } finally {
      if (this.exportController === controller) {
        this.exportController = null; button.disabled = this.selected?.state !== 'available';
        this.q('[data-export-cancel]').hidden = true;
      }
    }
  }

  setControls(enabled) {
    for (const selector of ['[data-minus]', '[data-plus]', '[data-fit]', '[data-close]', '[data-stop]', '[data-reset]', '[data-effect]'])
      this.querySelectorAll(selector).forEach(input => { input.disabled = !enabled; });
    this.q('[data-motion]').disabled = !enabled || !this.manifest?.motions.length;
    this.q('[data-play]').disabled = !enabled || !this.manifest?.motions.length;
    this.q('[data-expression]').disabled = !enabled || !this.manifest?.expressionCount;
    this.q('[data-clip-search]').disabled = !enabled;
    const physics = this.q('[data-effect="physics"]');
    physics.disabled = !enabled || !this.manifest?.physics;
  }

  close(cancelled = false) {
    ++this.generation; ++this.motionGeneration;
    this.controller?.abort(abortError()); this.controller = null;
    this.player?.dispose(); this.player = null; this.manifest = null;
    this.parameterEvents?.abort(); this.rows = []; this.partRows = [];
    this.setControls(false);
    // A destroyed WebGL canvas cannot safely become a fresh context on all devices.
    const canvas = this.q('canvas');
    if (canvas) { const fresh = canvas.cloneNode(false); fresh.removeAttribute('style'); fresh.removeAttribute('width'); fresh.removeAttribute('height'); canvas.replaceWith(fresh); }
    this.dataset.state = 'idle';
    this.q('[data-overlay]').hidden = false;
    this.q('[data-status]').textContent = cancelled ? this.say('已取消加载', 'Loading cancelled') : this.say('选择服装，开始预览', 'Choose a costume to preview');
    this.q('[data-detail]').textContent = this.say('点击后下载模型、纹理、动作与表情。', 'Model, textures, motions and expressions download when you open the preview.');
    this.q('[data-progress]').hidden = true;
    this.q('[data-progress-text]').textContent = '';
    this.q('[data-open]').hidden = false; this.q('[data-open]').textContent = this.say('加载预览', 'Load preview');
    this.q('[data-cancel]').hidden = true;
    this.q('[data-fps]').textContent = ''; this.q('[data-playing]').textContent = '—';
    for (const selector of ['[data-parameters]', '[data-parts]']) this.q(selector)?.replaceChildren();
    for (const selector of ['[data-parameter-count]', '[data-part-count]']) if (this.q(selector)) this.q(selector).textContent = '';
    for(const selector of ['[data-motion-shortcuts]','[data-expression-shortcuts]'])this.q(selector)?.replaceChildren();
    for (const selector of ['[data-motion]', '[data-expression]']) this.q(selector).replaceChildren(new Option('—', ''));
  }

  async load() {
    this.close();
    const selected = this.selected;
    if (selected?.state !== 'available') return;
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    this.dataset.state = 'loading';
    this.q('[data-open]').hidden = true; this.q('[data-cancel]').hidden = false;
    const progress = this.q('[data-progress]'); progress.hidden = false; progress.removeAttribute('value');
    const update = snapshot => {
      if (signal.aborted || generation !== this.generation) return;
      this.q('[data-status]').textContent = snapshot.phase === 'manifest' ? this.say('正在读取资源清单', 'Reading resource manifest') : this.say('正在下载资源', 'Downloading resources');
      this.q('[data-detail]').textContent = this.say('下载完成后将初始化模型。可随时取消或切换服装。', 'Model initialization follows download. You can cancel or switch costumes at any time.');
      if (snapshot.total) {
        const percent = Math.min(100, snapshot.loaded / snapshot.total * 100);
        progress.value = percent;
        this.q('[data-progress-text]').textContent = `${percent.toFixed(0)}% · ${mb(snapshot.loaded)} / ${mb(snapshot.total)}${snapshot.cached ? ` · ${this.say('缓存', 'cached')} ${mb(snapshot.cached)}` : ''}`;
      } else { progress.removeAttribute('value'); this.q('[data-progress-text]').textContent = this.say('正在确认下载大小…', 'Determining download size…'); }
    };
    try {
      const root = new URL(selected.root.startsWith('/content/') ? selected.root : this.config.base.replace(/\/$/, '') + selected.root, location.origin).href;
      const coreUrl = `${globalThis[Symbol.for('ournotes.code-root.v1')] ?? this.config.base}vendor/live2d/live2dcubismcore.min.js`;
      const { resources, createLive2DPlayer } = await loadLive2DPreview(root, coreUrl, { signal, onProgress: update });
      signal.throwIfAborted();
      this.q('[data-status]').textContent = this.say('正在初始化模型', 'Initializing model');
      this.q('[data-detail]').textContent = this.say('下载完成，正在准备播放器、解析模型与上传纹理。', 'Download complete. Preparing the player, parsing the model and uploading textures.');
      progress.removeAttribute('value');
      this.dataset.state = 'initializing';
      signal.throwIfAborted();
      const player = await createLive2DPlayer({ canvas: this.q('canvas'), resources, signal,
        coreUrl,
        onStats: stats => {
          if (generation !== this.generation) return;
          this.q('[data-fps]').textContent = `${stats.fps} FPS`;
          if (this.q('[data-debug-panel]')?.hidden || !this.q('[data-debug]')?.open) return;
          for (const row of this.rows) {
            if (row.node.hidden) continue;
            const value = stats.values[row.index]; row.output.value = value.toFixed(2);
            if (!row.lock.checked) row.slider.value = value;
          }
        },
        onMotionEnd: () => {
          if (generation !== this.generation || !this.playing) return;
          if (this.q('[data-loop]').checked) this.play();
          else { this.playing = false; this.q('[data-playing]').textContent = this.say('播放结束', 'Finished'); }
        },
        onError: error => { if (generation === this.generation) this.fail(error); }
      });
      if (signal.aborted || generation !== this.generation) { player.dispose(); return; }
      this.player = player; this.manifest = resources.manifest;
      this.populateDebug();
      this.setControls(true);
      this.querySelectorAll('[data-effect]').forEach(input => {
        if (input.dataset.effect === 'physics') input.checked = Boolean(this.manifest.physics);
        player.effect(input.dataset.effect, input.checked);
      });
      this.q('[data-overlay]').hidden = true; this.q('[data-cancel]').hidden = true;
      this.dataset.state = 'ready';
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      this.fail(error);
    }
  }

  fail(error) {
    this.close(); this.dataset.state = 'error';
    this.q('[data-status]').textContent = this.say('加载失败，可重试', 'Loading failed. Try again.');
    this.q('[data-detail]').textContent = String(error?.message || error);
    this.q('[data-open]').textContent = this.say('重试加载', 'Retry');
  }

  async play() {
    const motion = this.manifest?.motions[Number(this.q('[data-motion]').value)];
    if (!motion || !this.player) return;
    const generation = this.generation, request = ++this.motionGeneration;
    this.playing = false; this.player.stop();
    this.q('[data-playing]').textContent = this.say('正在准备动作…', 'Preparing motion…');
    try {
      const started = await this.player.play(motion.group, motion.index);
      if (generation !== this.generation || request !== this.motionGeneration) return;
      this.playing = Boolean(started);
      this.q('[data-playing]').textContent = started ? `${this.say('播放中', 'Playing')} · ${motion.sourceName}` : this.say('动作无法播放，请重试', 'Motion could not play. Try again.');
    } catch (error) { if (generation === this.generation && request === this.motionGeneration) this.q('[data-playing]').textContent = error.message; }
  }

  stop() {
    ++this.motionGeneration; this.playing = false; this.player?.stop();
    this.q('[data-playing]').textContent = this.say('已停止', 'Stopped');
  }

  populateDebug() {
    this.q('[data-clip-search]').value = '';
    this.populateClips(true);
    if (this.config.compact) return;
    this.parameterEvents = new AbortController();
    const signal = this.parameterEvents.signal;
    this.rows = this.player.parameters.map(parameter => {
      const { node, slider, output } = this.makeSlider(parameter, 'parameter');
      const label = document.createElement('label'); label.className = 'l2d-check';
      const lock = document.createElement('input'); lock.type = 'checkbox'; lock.setAttribute('aria-label', `${this.say('锁定', 'Lock')} ${parameter.id}`);
      label.append(lock, this.say('锁定', 'Lock')); node.lastChild.append(label);
      slider.addEventListener('input', () => { lock.checked = true; this.player.lock(parameter.index, Number(slider.value)); output.value = Number(slider.value).toFixed(2); }, { signal });
      lock.addEventListener('change', () => this.player.lock(parameter.index, lock.checked ? Number(slider.value) : null), { signal });
      return { ...parameter, node, slider, output, lock };
    });
    this.q('[data-parameters]').replaceChildren(...this.rows.map(r => r.node));
    this.q('[data-parameter-count]').textContent = String(this.rows.length);
    this.q('[data-search]').value = '';
    this.partRows = this.player.parts.map(part => {
      const row = this.makeSlider({ ...part, min: 0, max: 1 }, 'part');
      row.slider.addEventListener('input', () => { this.player.part(part.index, Number(row.slider.value)); row.output.value = Number(row.slider.value).toFixed(2); }, { signal });
      return { ...part, ...row };
    });
    this.q('[data-parts]').replaceChildren(...this.partRows.map(r => r.node));
    this.q('[data-part-count]').textContent = String(this.partRows.length);
  }

  populateClips(initial = false) {
    if (!this.manifest) return;
    const term = this.q('[data-clip-search]').value.trim().toLowerCase();
    const motionSelect = this.q('[data-motion]'), expressionSelect = this.q('[data-expression]');
    const previous = initial ? String(preferredMotion(this.manifest.motions)) : motionSelect.value;
    const matches = this.manifest.motions.map((m, i) => ({ value: String(i), label: `${clipLabel(m.sourceName, this.config.en)} · ${m.duration.toFixed(1)}s` }))
      .filter(m => m.label.toLowerCase().includes(term));
    motionSelect.replaceChildren(...matches.map(m => new Option(m.label, m.value)));
    if (matches.some(m => m.value === previous)) motionSelect.value = previous;
    if (!initial && motionSelect.value !== previous) this.stop();
    motionSelect.disabled = !matches.length; this.q('[data-play]').disabled = !matches.length;
    if (!matches.length) motionSelect.replaceChildren(new Option(this.say('无匹配动作', 'No matching motions'), ''));
    const expressions = this.manifest.resources.filter(r => r.file.endsWith('.exp3.json'));
    const expression = initial ? '' : expressionSelect.value;
    expressionSelect.replaceChildren(new Option(this.say('默认', 'Default'), ''), ...expressions.map(r => {
      const name = r.file.split('/').pop().replace('.exp3.json', '');
      return { name, label: clipLabel(name, this.config.en) };
    }).filter(e => e.name === expression || e.label.toLowerCase().includes(term)).map(e => new Option(e.label, e.name)));
    expressionSelect.value = expression;
    for(const [select,selector,isMotion] of [[motionSelect,'[data-motion-shortcuts]',true],[expressionSelect,'[data-expression-shortcuts]',false]]){
      const group=this.q(selector);if(!group)continue;group.replaceChildren();
      for(const option of [...select.options].filter(o=>!isMotion||o.value!=='').slice(0,6)){
        const b=document.createElement('button');b.type='button';b.textContent=option.textContent;b.setAttribute('aria-pressed',String(option.value===select.value));
        b.addEventListener('click',()=>{if(this.dataset.state!=='ready')return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));if(isMotion)this.play();for(const button of group.children)button.setAttribute('aria-pressed',String(button===b));});group.append(b);
      }
    }

  }

  makeSlider(parameter, kind) {
    const node = document.createElement('div'); node.className = 'l2d-param';
    const head = document.createElement('div'); head.className = 'l2d-param-head';
    const label = document.createElement('label'); label.textContent = parameter.id;
    const output = document.createElement('output'); output.value = parameter.default.toFixed(2);
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = parameter.min; slider.max = parameter.max;
    slider.step = String(Math.max((parameter.max - parameter.min) / 1000, .001)); slider.value = parameter.default;
    slider.id = `l2d-${this.uid}-${kind}-${parameter.index}`; label.htmlFor = slider.id;
    const track = document.createElement('div'); track.className = 'l2d-param-row'; track.append(slider);
    head.append(label, output); node.append(head, track);
    return { node, slider, output };
  }
}

if (!customElements.get('live2d-workbench')) customElements.define('live2d-workbench', Live2DWorkbench);
