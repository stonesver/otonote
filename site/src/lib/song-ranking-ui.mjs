import {renderRankingTable} from './song-ranking-table-ui.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {setupQuickOptions,selectedOptionText} from './tool-quick-options.mjs';
import {selectedControlValues,restoreFilterControl} from './filter-controls.mjs';
import {renderRankingDetail} from './song-ranking-detail.mjs';
import {rankingMetricExplanation} from './song-ranking-table.mjs';
import {RANKING_OPTIONS, rankingWebsiteEdition, defaultRankingDirection, rankRefinedSongRows, scopeRankingRows, rankingRowState, validateRankingOptions, editionName} from './song-ranking-options.mjs';
import {currentServerContext, gameServer} from './game-servers.mjs';
import {withSongSkillProfile, validateSongSkillProfile} from './song-skill-profile.mjs';
import {setupSongRankingReplay} from './song-ranking-replay-ui.mjs';
import {setupRankingChartDialog} from './song-ranking-chart-dialog.mjs';
const say = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
const metricLabel = key => RANKING_OPTIONS[key]?.[document.documentElement.lang.startsWith('en') ? 1 : 0] ?? key;
const node = (tag, text = '', cls = '') => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; };
const number = (n, digits = 0) => Number.isFinite(n) ? n.toLocaleString(document.documentElement.lang, {maximumFractionDigits:digits}) : '—';
const specialMetrics = ['gekisouMultiplier', 'rankingBonusShare', 'rankingBonus', 'sampleCount', 'standardError'];
class SongRanking extends HTMLElement {
  connectedCallback() {
    if (this.events) return;
    this.events = new AbortController(); this.expanded = new Set();
    const listen = (el, type, fn) => el.addEventListener(type, fn, {signal:this.events.signal});
    listen(this.querySelector('[data-reload]'), 'click', () => location.reload());
    try {
      this.data = JSON.parse(this.querySelector('[data-ranking-data]').textContent);
      if (!Array.isArray(this.data.rankings.ordinary) || !Array.isArray(this.data.rankings.gekisou)) throw Error('Invalid ranking data');
      this.mode = 'ordinary'; this.metric = 'expectedScore';
      this.siteEdition=rankingWebsiteEdition(location.pathname,this.dataset.siteEdition);
      this.querySelector('[data-filter="edition"]').value=this.siteEdition;
      this.chartDialog=setupRankingChartDialog(this,this.data.rankings.chartSources??{});
      this.querySelector('[data-direction]').value = defaultRankingDirection(this.metric);
      try { this.server = currentServerContext().serverId; } catch (error) { this.serverError = error.message; }
      for (const button of this.querySelectorAll('[data-mode]')) listen(button, 'click', () => {
        this.mode = button.dataset.mode; this.expanded.clear();
        if (this.mode === 'ordinary' && specialMetrics.includes(this.metric)) this.setMetric('expectedScore');
        this.render();
      });
      for (const input of this.querySelectorAll('[data-filter], [data-duration], [data-overhead], [data-direction], [data-grouping], [data-grade-profile], [data-grade-target], [data-skill-percent], [data-skill-seconds]')) listen(input, 'input', () => { this.render(); });
      for(const button of this.querySelectorAll('[data-edition-choice]'))listen(button,'click',()=>{this.querySelector('[data-filter="edition"]').value=button.dataset.editionChoice;this.render();});
      const sortBy = (metric, header = false) => {
        if (header && metric === this.metric) this.querySelector('[data-direction]').value = this.querySelector('[data-direction]').value === 'asc' ? 'desc' : 'asc';
        else this.setMetric(metric);
        this.revealMetric = !header; this.render();
      };
      for (const button of this.querySelectorAll('[data-board]')) listen(button,'click',()=>sortBy(button.dataset.board));
      listen(this.querySelector('[data-ranking-head]'),'click',event=>{const button=event.target.closest('[data-sort]');if(button)sortBy(button.dataset.sort,true);});
      listen(this.querySelector('[data-metric]'),'change',event=>sortBy(event.target.value));
      const closePanel = panel => { panel.open=false; panel.querySelector('summary').focus(); };
      for (const panel of this.querySelectorAll('[data-toolbar-panel]')) {
        listen(panel,'toggle',()=>{if(panel.open)for(const other of this.querySelectorAll('[data-toolbar-panel]'))if(other!==panel)other.open=false;});
        for(const close of panel.querySelectorAll('[data-close-panel]'))listen(close,'click',()=>closePanel(panel));
      }
      listen(this,'keydown',event=>{if(event.key==='Escape'){const panel=this.querySelector('[data-toolbar-panel][open],.ranking-provenance[open]');if(panel){closePanel(panel);event.preventDefault();}}});
      listen(document,'pointerdown',event=>{for(const panel of this.querySelectorAll('[data-toolbar-panel][open],.ranking-provenance[open]'))if(!panel.contains(event.target))panel.open=false;});
      listen(this.querySelector('[data-copy-skills]'), 'click', () => {
        const slots = [...this.querySelectorAll('[data-skill-slot]')];
        for (const slot of slots.slice(1)) for (const key of ['percent','seconds']) slot.querySelector(`[data-skill-${key}]`).value = slots[0].querySelector(`[data-skill-${key}]`).value;
        this.render();
      });
      listen(this.querySelector('[data-load-more]'), 'click', () => this.loadMore());
      const results = this.querySelector('[data-results]');
      listen(results, 'scroll', () => {
        if (results.clientHeight > 0 && results.scrollHeight - results.scrollTop - results.clientHeight < 160) this.loadMore();
      });
      const clearFilters = () => {
        for (const input of this.querySelectorAll('[data-filter]')) restoreFilterControl(input, input.dataset.filter==='edition'?this.siteEdition:input.tagName === 'SELECT' ? 'all' : '');
        this.render();
      };
      for (const button of this.querySelectorAll('[data-reset], [data-empty-reset]')) listen(button, 'click', clearFilters);
      listen(this.querySelector('[data-show-all]'), 'click', () => { this.querySelector('[data-replay-method]').value = 'linear'; this.render(); });
      listen(this.querySelector('[data-reset-all]'), 'click', () => {
        this.replays.reset(); this.mode = 'ordinary'; this.setMetric('expectedScore');
        for (const field of this.querySelectorAll('[data-filter]')) restoreFilterControl(field, field.dataset.filter==='edition'?this.siteEdition:field.tagName === 'SELECT' ? 'all' : '');
        this.querySelector('[data-grade-profile]').value = 'benchmark';
        this.querySelector('[data-grade-target]').value = '6';
        this.querySelector('[data-overhead]').value = '0'; this.querySelector('[data-duration]').value = 'chart';
        this.querySelector('[data-grouping]').value = 'charts'; this.querySelector('[data-replay-fps]').value = '60';
        for (const field of this.querySelectorAll('[data-skill-percent]')) field.value = '100';
        for (const field of this.querySelectorAll('[data-skill-seconds]')) field.value = '5';
        this.render(); this.querySelector('[data-metric]').focus();
      });
      this.shortcuts = setupQuickOptions(this);
      this.replays = setupSongRankingReplay(this, () => { this.render(); });
      this.querySelector('[data-startup]').hidden = true;
      this.render();
    } catch (error) {
      this.showError(say('排行榜数据未能初始化，请重新加载页面。', 'Ranking data could not initialize. Reload the page.'));
      this.querySelector('[data-startup]').hidden = true;
      this.querySelector('[data-reload]').hidden = false;
      this.querySelector('[data-reset-all]').hidden = true;
    }
  }
  disconnectedCallback() { this.chartDialog?.destroy();this.shortcuts?.destroy(); this.replays?.destroy(); this.events?.abort(); this.events = null; }
  setMetric(metric) {
    this.metric = metric;
    this.querySelector('[data-direction]').value = defaultRankingDirection(metric);
    // A value interval belongs to its metric; keep level/time/other filters.
    for (const key of ['minValue','maxValue']) this.querySelector(`[data-filter="${key}"]`).value = '';
  }
  showError(message) {
    this.replays?.invalidate();
    this.querySelector('[data-error]').hidden = false; this.querySelector('[data-error-message]').textContent = message;
    for (const error of this.querySelectorAll('[data-panel-error]')) { error.hidden=false; error.textContent=message; }
    this.querySelector('[data-results]').hidden = true; this.querySelector('[data-empty]').hidden = true;
    this.querySelector('[data-count]').textContent = '—';
    this.querySelector('[data-context]').textContent = say('请修正条件后继续比较', 'Correct the inputs to continue');
    this.querySelector('[data-result-status]').textContent = ''; this.querySelector('[data-range]').textContent = '—';
    this.tableOptions = null;
    this.querySelector('[data-load-more]').disabled = true;
  }
  render() {
    try { this.renderResults(); }
    catch (error) { this.showError(say('结果未能更新。请恢复默认条件后重试。', 'Results could not update. Restore the defaults and try again.')); }
  }
  renderResults() {
    const q = selector => this.querySelector(selector), en = document.documentElement.lang.startsWith('en');
    this.shortcuts?.sync();
    const profile = this.mode === 'gekisou' ? 'benchmark' : q('[data-grade-profile]').value, custom = profile === 'custom';
    q('[data-profile-controls]').hidden = this.mode === 'gekisou'; q('[data-custom-skills]').hidden = !custom;
    q('.ranking-advanced-replay').hidden = this.mode === 'gekisou';
    q('[data-value-range]').hidden = RANKING_OPTIONS[this.metric][2] === 'text';
    for (const button of this.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
    for (const button of this.querySelectorAll('[data-board]')) button.setAttribute('aria-pressed', String(button.dataset.board === this.metric));
    for (const option of q('[data-metric]').options) option.disabled = this.mode === 'ordinary' && specialMetrics.includes(option.value);
    q('[data-metric]').value = this.metric;
    q('[data-grade-controls]').hidden = !['requiredPower','targetScore'].includes(this.metric);
    const filters = Object.fromEntries([...this.querySelectorAll('[data-filter]')].map(e => [e.dataset.filter, e.multiple ? selectedControlValues(e) : e.value]));
    for(const button of this.querySelectorAll('[data-edition-choice]'))button.setAttribute('aria-pressed',String(button.dataset.editionChoice===filters.edition));
    const skills = [...this.querySelectorAll('[data-skill-slot]')].map(slot => ({percent:slot.querySelector('[data-skill-percent]').value === '' ? NaN : Number(slot.querySelector('[data-skill-percent]').value), seconds:Number(slot.querySelector('[data-skill-seconds]').value)}));
    const activeInputs = [...this.querySelectorAll('[data-filter][type=number], [data-overhead]'), ...(custom ? this.querySelectorAll('[data-skill-percent]') : [])];
    for (const field of activeInputs) field.setAttribute('aria-invalid', String(!field.validity.valid));
    const invalid = activeInputs.find(field => !field.validity.valid);
    let options;
    try {
      if (invalid) throw Error(say(`${invalid.getAttribute('aria-label') ?? '数值'}超出允许范围，请填写有效数值。`, `${invalid.getAttribute('aria-label') ?? 'Value'} is outside the allowed range. Enter a valid number.`));
      if (custom) validateSongSkillProfile(skills);
      options = validateRankingOptions({...filters, metric:this.metric, direction:q('[data-direction]').value, grouping:q('[data-grouping]').value,
        targetRank:Number(q('[data-grade-target]').value), locale:document.documentElement.lang, durationBasis:q('[data-duration]').value, overhead:q('[data-overhead]').value, profile, skills}, en);
    } catch (error) { this.showError(error.message); return; }
    this.options = options;
    q('[data-error]').hidden = true; q('[data-results]').hidden = false;
    for (const error of this.querySelectorAll('[data-panel-error]')) error.hidden=true;
    const tags = q('[data-ranking-filter-tags]'); tags.replaceChildren();
    for (const field of this.querySelectorAll('[data-filter]')) {
      if (field.multiple ? !selectedControlValues(field).length : field.value === '' || field.value === 'all' || field.dataset.filter==='edition'&&field.value===this.siteEdition) continue;
      const label = field.tagName === 'SELECT' ? selectedOptionText(field) : `${field.getAttribute('aria-label')} ${field.value}`;
      const button = node('button', `${label} ×`); button.type = 'button'; button.setAttribute('aria-label', say(`取消筛选：${label}`, `Remove filter: ${label}`));
      button.addEventListener('click', () => { restoreFilterControl(field, field.dataset.filter==='edition'?this.siteEdition:field.tagName === 'SELECT' ? 'all' : ''); this.render(); (tags.querySelector('button') ?? q('.ranking-clear')).focus(); }); tags.append(button);
    }
    tags.hidden = !tags.children.length;
    q('[data-filter-count]').textContent = String(tags.children.length); q('[data-filter-count]').hidden = !tags.children.length;
    const profileLabel = this.mode === 'gekisou' ? say('激奏固定基准', 'Fixed Gekisou benchmark') : custom ? say('手填五技能', 'Five entered skills') : profile === 'none' ? say('无加分技能', 'No score skills') : say('基准五技能', 'Five benchmark skills');
    q('[data-calculation-profile]').textContent = profileLabel;
    q('[data-skill-summary]').textContent = custom ? say('先按技能窗口快速估算；逐谱精算遍历 120 种发动顺序并逐音符计算。', 'Skill windows provide quick estimates; replay computes every note across all 120 skill orders.') : profile === 'none' ? say('无技能基础分已逐音符计算。', 'No-skill baseline scores were calculated note by note.') : say('五次 +100% / 5 秒技能，60 FPS 基准已预先逐音符计算。', 'Five +100% / 5-second skills; the 60 FPS benchmark was computed note by note.');
    const activeSkills = custom ? skills : Array.from({length:5}, () => ({percent:profile === 'none' ? 0 : 100, seconds:profile === 'none' ? 0 : 5}));
    let rows = scopeRankingRows(this.data.rankings[this.mode], filters.edition).map(row => ({...row, p10Score:row.p10Score ?? (row.minimumScore === row.maximumScore ? row.minimumScore : null)}));
    if (profile !== 'benchmark') rows = rows.map(row => withSongSkillProfile(row, activeSkills));
    const quickRanked = rankRefinedSongRows(rows, options);
    const replayView = this.replays.sync({skills:activeSkills, rows:quickRanked, mode:this.mode, profile});
    if (replayView) rows = this.replays.rows(rows);
    this.replayView = replayView;
    const ranked = rankRefinedSongRows(rows, options);
    const valid = ranked.filter(row => row.rank !== null);
    const scoreLabel = replayView ? say('逐谱平均分','Replay mean') : custom ? say('快速平均参考分','Quick estimated mean') : profile === 'none' ? say('无技能参考分','No-skill score') : this.mode === 'gekisou' ? say('样本平均分','Sample mean') : say('基准平均分','Benchmark mean');
    const size = 50;
    q('[data-count]').textContent = say(`${ranked.length} 张谱面`, `${ranked.length} charts`);
    q('[data-context]').textContent = [this.mode === 'ordinary' ? say('普通','Ordinary') : say('激奏样本 · 非实战保底','Gekisou samples · not guaranteed'), profileLabel,
      ['requiredPower','targetScore'].includes(this.metric) ? `${say('目标','Target')} ${q('[data-grade-target]').selectedOptions[0].textContent}` : '',
      `${metricLabel(this.metric)} ${options.direction === 'asc' ? '↑' : '↓'}`,
      replayView ? say('仅已完成精算内排名','Completed replays only') : ''].filter(Boolean).join(' · ');
    const calculated = ranked.filter(row => rankingRowState(row) === 'calculated').length, pending = ranked.filter(row => row.pending).length;
    q('[data-result-status]').textContent = say(`可排名 ${valid.length} · 有分 ${calculated} · 待算 ${pending} · 缺条件 ${ranked.length-calculated-pending}`, `${valid.length} ranked · ${calculated} scored · ${pending} pending · ${ranked.length-calculated-pending} unavailable`);
    const releases = Object.entries(this.data.rankings.releases ?? {}).filter(([edition])=>edition===filters.edition).map(([edition, release]) => `${editionName(edition,en)} ${release}`).join(' / ');
    q('[data-identity]').textContent = [say('结果范围：', 'Result scope: ') + editionName(filters.edition,en),
      this.server ? say('当前区服：', 'Selected server: ') + gameServer(this.server)?.[en ? 'englishLabel' : 'label'] : say('当前区服未选择', 'No server selected'), releases,
      this.serverError ?? ''].filter(Boolean).join(' · ');
    q('[data-metric-help]').textContent = this.mode === 'gekisou' && ['minimumScore','maximumScore','p10Score','scoreSpread','p10Efficiency'].includes(this.metric)
      ? say('激奏数值来自固定 LUCK 样本，最低／最高为样本范围，不是理论极值或实战保底。', 'Gekisou uses fixed LUCK samples. Minimum and maximum are sample extrema, not theoretical bounds or live guarantees.')
      : ['minimumScore','maximumScore','p10Score','scoreSpread','p10Efficiency'].includes(this.metric)
        ? say('普通演出参考值按当前技能条件比较；自定义技能遍历 120 种等可能顺序。P10 为由低到高第 12 项，不是实战保底。基准相同技能的范围可能相等。', 'Ordinary reference values follow the chosen skills; custom skills compare 120 equally likely orders. P10 is the 12th lowest, not a live guarantee. Identical benchmark skills can have equal extrema.')
        : ['averageDensity','peakDensity','eventCount','bpmMax','level'].includes(this.metric)
          ? say('结构指标描述计分判定（包含滑条自动计数），不等于游玩难度；无分数也可按已有结构数值比较。', 'Structure metrics describe scoring events, including generated slide ticks. They do not measure playing difficulty; known structure values can rank without scores.')
          : say(`效率分母：${options.durationBasis === 'chart' ? '谱面' : '音频'}时长 + ${number(options.overhead,2)} 秒；缺少所选时长时不计算效率。`, `Efficiency denominator: ${options.durationBasis} duration + ${number(options.overhead,2)} seconds. Missing duration has no efficiency.`);
    const explanation=rankingMetricExplanation(this.metric,this.mode,en); q('[data-metric-explanation]').textContent=explanation; q('[data-metric-explanation]').hidden=!explanation; q('[data-grouping-explanation]').hidden=options.grouping!=='songs';
    q('[data-value-unit]').textContent = RANKING_OPTIONS[this.metric][2] === 'percent' ? say('（比例原值，0.2 = 20%）', '(raw ratio: 0.2 = 20%)') : `(${metricLabel(this.metric)})`;
    q('[data-empty]').hidden = ranked.length > 0;
    q('[data-empty] strong').textContent = replayView ? say('当前筛选没有完成精算的谱面', 'No completed replay matches these filters') : say('没有符合这些条件的谱面', 'No charts match these filters');
    q('[data-empty] p').textContent = replayView ? say('开始逐谱精算，或切回全部筛选结果。若刚按每首歌选谱或数值范围比较，可放宽条件查看其他已算结果。', 'Run chart replay or return to all filtered results. Relax grouping or value filters to see other completed results.') : say('清空筛选，或放宽版本、计算状态、难度与数值区间。', 'Clear filters or relax edition, calculation state, difficulty and numeric ranges.');
    q('[data-show-all]').hidden = !replayView;
    this.tableOptions = {rows:ranked,page:0,size,mode:this.mode,metric:this.metric,direction:options.direction,locale:document.documentElement.lang,
      artwork:this.data.artwork,expanded:this.expanded,detail:(root,row)=>this.detail(root,row),reveal:this.revealMetric,scoreLabel};
    renderRankingTable(this,this.tableOptions);
    this.visibleCount = Math.min(size,ranked.length);
    q('[data-results]').scrollTop = 0;
    this.updateLoadedCount();
    this.revealMetric=false;
    this.shortcuts?.sync();
  }
  loadMore() {
    const options = this.tableOptions;
    if (!options || this.visibleCount >= options.rows.length) return;
    const next = options.rows.slice(this.visibleCount, this.visibleCount + options.size);
    renderRankingTable(this,{...options,rows:next,page:0,append:true,reveal:false});
    this.visibleCount += next.length;
    this.updateLoadedCount();
  }
  updateLoadedCount() {
    const total = this.tableOptions.rows.length, complete = this.visibleCount >= total;
    this.querySelector('[data-range]').textContent = say(`已显示 ${this.visibleCount} / ${total} 项`, `Showing ${this.visibleCount} of ${total}`);
    const more = this.querySelector('[data-load-more]');
    more.disabled = complete;
    more.textContent = complete ? say('已全部加载', 'All loaded') : say('加载更多', 'Load more');
  }
  detail(root,row) {
    renderRankingDetail(root,row,{mode:this.mode,locale:document.documentElement.lang,server:this.server,edition:this.options.edition,artwork:this.data.artwork[row.trackId],openChart:(chart,edition)=>this.chartDialog.open(chart,edition)});
    this.activationDetail(root,row);
  }
  activationDetail(root,row){
    if(row.replaySource){
      const profile=this.querySelector('[data-grade-profile]').value;
      const skills=this.mode==='ordinary'&&profile==='custom'?[...this.querySelectorAll('[data-skill-slot]')].map(slot=>({percent:Number(slot.querySelector('[data-skill-percent]').value),seconds:Number(slot.querySelector('[data-skill-seconds]').value)})):
        Array.from({length:5},()=>({percent:profile==='none'&&this.mode==='ordinary'?0:row.benchmark.skillPercent,seconds:row.benchmark.skillSeconds}));
      root.append(skillActivation(this,null,{mode:this.mode,ranking:{replaySource:row.replaySource,sourceId:row.sourceId,trackId:row.trackId,difficulty:row.difficulty,benchmark:row.benchmark,skills,frameRate:Number(this.querySelector('[data-replay-fps]').value)}}));
    }
  }

}
if (!customElements.get('song-ranking')) customElements.define('song-ranking', SongRanking);
