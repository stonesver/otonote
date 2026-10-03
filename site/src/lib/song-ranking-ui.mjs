import {skillActivation} from './skill-activation-view.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {rankGradeRows,SCORE_GRADES} from './song-grade-ranking.mjs';
import { rankSongRows, RANKING_METRICS } from './song-ranking-view.mjs';
import { withSongSkillProfile, validateSongSkillProfile } from './song-skill-profile.mjs';
import { setupSongRankingReplay } from './song-ranking-replay-ui.mjs';
import { translateUiText } from './ui-text-localizer.ts';
const say = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
const ui = (value = '') => document.documentElement.lang.startsWith('en') ? translateUiText(value) : value;
const metricLabels = {
  scoreMultiplier: 'Score multiplier', p10Score: 'P10 reference score', difficultyFactor: 'Difficulty multiplier',
  comboFactor: 'Weighted combo multiplier', skillMultiplier: 'Ordinary skill gain multiplier',
  gekisouMultiplier: 'Gekisou / ordinary score multiplier', rankingBonusShare: 'Gekisou placement bonus share'
};
const metricLabel = key => metricLabels[key] ? say(RANKING_METRICS[key], metricLabels[key]) : ui(RANKING_METRICS[key]);
const node = (tag, text = '', cls = '') => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; };
const number = (n, digits = 0) => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const metricValue = (key, n) => !Number.isFinite(n) ? '—' : key === 'rankingBonusShare' ? `${number(n * 100, 2)}%`
  : key.endsWith('Factor') || key.endsWith('Multiplier') ? `${number(n, 4)}×` : number(n, 2);
class SongRanking extends HTMLElement {
  connectedCallback() {
    if (this.events) return;
    this.data = JSON.parse(this.querySelector('[data-ranking-data]').textContent);
    this.mode = 'ordinary'; this.metric = new URLSearchParams(location.search).get('view')==='grade'?'requiredPower':'expectedScore'; this.page = 0; this.events = new AbortController(); this.expanded = new Set();
    const listen = (el, type, fn) => el.addEventListener(type, fn, { signal: this.events.signal });
    for (const button of this.querySelectorAll('[data-mode]')) listen(button, 'click', () => {
      this.mode = button.dataset.mode; this.page = 0; this.expanded.clear();
      if(this.mode==='gekisou'&&this.metric==='requiredPower')this.metric='expectedScore';
      if(this.mode==='gekisou'&&this.metric==='p10Score'&&!this.data.rankings.gekisou.some(row=>Number.isFinite(row.p10Score)))this.metric='expectedScore';
      if (this.mode === 'ordinary' && ['gekisouMultiplier','rankingBonusShare'].includes(this.metric)) this.metric = 'expectedScore';
      this.render();
    });
    for (const input of this.querySelectorAll('[data-filter], [data-duration]')) listen(input, 'input', () => { this.page = 0; this.render(); });
    for (const button of this.querySelectorAll('[data-board], [data-sort]')) listen(button, 'click', () => { this.metric = button.dataset.board ?? button.dataset.sort; if(this.metric==='requiredPower')this.mode='ordinary'; this.page = 0; this.render(); });
    for(const input of this.querySelectorAll('[data-grade-target],[data-grade-profile],[data-grade-score],[data-skill-percent],[data-skill-seconds]'))listen(input,'input',()=>{this.page=0;this.render();});
    listen(this.querySelector('[data-copy-skills]'),'click',()=>{
      const slots=[...this.querySelectorAll('[data-skill-slot]')];
      for(const slot of slots.slice(1))for(const key of ['percent','seconds'])slot.querySelector(`[data-skill-${key}]`).value=slots[0].querySelector(`[data-skill-${key}]`).value;
      this.page=0;this.render();
    });
    listen(this.querySelector('[data-metric]'), 'change', event => { this.metric = event.target.value || 'expectedScore'; this.page = 0; this.render(); });
    listen(this.querySelector('[data-prev]'), 'click', () => { this.page--; this.render(); });
    listen(this.querySelector('[data-next]'), 'click', () => { this.page++; this.render(); });
    listen(this.querySelector('[data-reset]'), 'click', () => { for (const input of this.querySelectorAll('[data-filter]')) input.value = input.tagName === 'SELECT' ? 'all' : ''; this.page = 0; this.render(); });
    this.shortcuts=setupQuickOptions(this);
    this.replays=setupSongRankingReplay(this,()=>{this.page=0;this.render();});
    this.render();
  }
  disconnectedCallback() { this.shortcuts?.destroy(); this.replays?.destroy(); this.events?.abort(); this.events = null; }
  render() {
    this.shortcuts?.sync();
    const filters = Object.fromEntries([...this.querySelectorAll('[data-filter]')].map(e => [e.dataset.filter, e.dataset.filter === 'maxLevel' && e.value === '' ? 'all' : e.value]));
    const tags=this.querySelector('[data-ranking-filter-tags]');tags.replaceChildren();
    for(const field of this.querySelectorAll('[data-filter]')){if(field.value===''||field.value==='all')continue;const b=node('button',`${field.tagName==='SELECT'?field.selectedOptions[0].textContent:field.dataset.filter==='maxLevel'?`Lv.≤${field.value}`:field.value} ×`);b.type='button';b.setAttribute('aria-label',`取消筛选：${b.textContent.slice(0,-2)}`);b.addEventListener('click',()=>{field.value=field.tagName==='SELECT'?'all':'';this.page=0;this.render();});tags.append(b);}
    tags.hidden=!tags.children.length;
    const timing = { durationBasis: this.querySelector('[data-duration]').value };
    let rows = this.data.rankings[this.mode].map(row=>({...row,p10Score:row.p10Score??(row.minimumScore===row.maximumScore?row.minimumScore:null)}));
    const options = { ...filters, ...timing, metric: this.metric };
    const gradeView=this.metric==='requiredPower',rawScore=this.querySelector('[data-grade-score]').value;
    if (gradeView && this.previousMetric !== 'requiredPower') this.querySelector('[data-calculation-controls]').open = true;
    this.previousMetric = this.metric;
    const score=rawScore===''?null:Number(rawScore),invalidScore=score!==null&&(!Number.isSafeInteger(score)||score<0);
    const skills=[...this.querySelectorAll('[data-skill-slot]')].map(slot=>({percent:slot.querySelector('[data-skill-percent]').value===''?NaN:Number(slot.querySelector('[data-skill-percent]').value),seconds:Number(slot.querySelector('[data-skill-seconds]').value)}));
    let invalidSkill=false;try{validateSongSkillProfile(skills);}catch{invalidSkill=true;}
    const profile=this.mode==='gekisou'?'benchmark':this.querySelector('[data-grade-profile]').value,custom=profile==='custom';
    this.querySelector('[data-calculation-profile]').textContent = this.mode === 'gekisou' ? say('激奏固定基准', 'Fixed Gekisou benchmark') : custom ? say('我的五个技能', 'My five skills') : profile === 'none' ? say('无加分技能', 'No score skills') : say('基准五技能', 'Five benchmark skills');
    this.querySelector('[data-profile-controls]').hidden=this.mode==='gekisou';
    this.querySelector('[data-custom-skills]').hidden=!custom;
    this.querySelector('[data-skill-summary]').textContent=custom?(invalidSkill?say('请为五个技能填写 0–1000% 加分和 0–20 秒时长。','Enter a 0–1000% bonus and a duration of 0–20 seconds for each skill.'):say('先按技能窗口快速估算；逐谱精算会遍历 120 种发动顺序并逐音符重新计算。','Skill windows provide quick estimates; chart replay recalculates every note across all 120 skill orders.')):profile==='none'?say('无技能基础分已逐音符计算，直接比较谱面本身的转分能力。','No-skill scores were calculated note by note and are ready for chart comparison.'):say('100,000 综合力 · 五次 +100% / 5 秒技能 · 60 FPS。基准已预先逐音符计算，可直接比较。','100,000 power · five +100% / 5-second skills · 60 FPS. The benchmark is already calculated note by note and ready to compare.');
    const gradeOptions={...options,skills,targetRank:Number(this.querySelector('[data-grade-target]').value),profile,score:invalidScore?null:score};
    this.querySelector('[data-grade-controls]').hidden=!gradeView;
    if(custom&&invalidSkill)rows=[];
    const activeSkills=profile==='custom'?skills:Array.from({length:5},()=>({percent:profile==='none'?0:100,seconds:profile==='none'?0:5}));
    if(profile!=='benchmark')rows=rows.map(row=>withSongSkillProfile(row,activeSkills));
    const quickRanked=gradeView?rankGradeRows(rows,gradeOptions):rankSongRows(rows,options);
    const replayView=this.replays.sync({skills:activeSkills,rows:quickRanked,mode:this.mode,profile});
    if(replayView)rows=this.replays.rows(rows);
    this.replayView=replayView;
    const scoreLabel=replayView?say('逐谱平均分','Replay mean score'):custom?say('快速参考分','Quick estimate'):profile==='none'?say('无技能参考分','No-skill score'):say('基准得分','Benchmark score');
    const ranked = gradeView?rankGradeRows(rows,gradeOptions):rankSongRows(rows, options);
    const byScore = rankSongRows(rows, { ...options, metric: 'expectedScore' });
    const byEfficiency = rankSongRows(rows, { ...options, metric: 'efficiency' }).filter(row => row.rank !== null);
    const maxScore = byScore[0]?.expectedScore || 1, maxEfficiency = byEfficiency[0]?.efficiency || 1;
    const size = 25, pages = Math.max(1, Math.ceil(ranked.length / size));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    for (const button of this.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
    for (const button of this.querySelectorAll('[data-board]')) button.setAttribute('aria-pressed', String(button.dataset.board === this.metric));
    const metricSelect = this.querySelector('[data-metric]');
    for (const option of metricSelect.options) option.disabled = (this.mode === 'ordinary' && ['gekisouMultiplier','rankingBonusShare'].includes(option.value)) || (option.value==='p10Score'&&!rows.some(row=>Number.isFinite(row.p10Score)));
    metricSelect.value = ['expectedScore','efficiency','requiredPower'].includes(this.metric) ? '' : this.metric;
    for (const button of this.querySelectorAll('[data-sort]')) {
      const active = button.dataset.sort === this.metric;
      button.disabled=gradeView;
      if(gradeView){button.textContent=button.dataset.sort==='expectedScore'?'参考综合力（约） ↑':'目标分数线';button.closest('th').setAttribute('aria-sort',button.dataset.sort==='expectedScore'?'ascending':'none');continue;}
      button.textContent = `${button.dataset.sort === 'expectedScore' ? scoreLabel : ui('每秒得分')}${active ? ' ↓' : ''}`;
      button.closest('th').setAttribute('aria-sort', active ? 'descending' : 'none');
    }
    this.querySelector('[data-count]').textContent = say(`${ranked.length} 张谱面`, `${ranked.length} charts`);
    this.querySelector('[data-context]').textContent = `${this.mode === 'ordinary' ? say('普通演出','Ordinary live') : say('激奏演出','Gekisou live')} · ${timing.durationBasis === 'chart' ? say('谱面时长','Chart duration') : say('音频时长','Audio duration')} · ${this.metric==='expectedScore'?scoreLabel:metricLabel(this.metric)}${say('排序',' order')}`;
    if(gradeView)this.querySelector('[data-context]').textContent=invalidScore?say('分数需为非负整数','Score must be a non-negative integer'):custom&&invalidSkill?say('加分比例需为 0–1000%','Skill bonus must be 0–1000%'):say(`统一曲库 · ${SCORE_GRADES[gradeOptions.targetRank-2]} 档 · ${profile==='none'?'无加分技能':custom?'自定义技能':'榜单技能基准'} · 参考综合力从低到高`, `Shared library · Grade ${SCORE_GRADES[gradeOptions.targetRank-2]} · ${profile==='none'?'No score skills':custom?'Custom skills':'Benchmark skills'} · Required power, lowest first`);
    if(replayView)this.querySelector('[data-context]').textContent+=say(` · 已算谱面内排名（${ranked.length} 张）`, ` · Ranks among ${ranked.length} completed charts`);
    this.querySelector('[data-page]').textContent = `${this.page + 1} / ${pages}`;
    this.querySelector('[data-range]').textContent = ranked.length ? `第 ${this.page * size + 1}–${Math.min(ranked.length, (this.page + 1) * size)} 项，共 ${ranked.length} 项` : '没有匹配结果';
    this.querySelector('[data-prev]').disabled = this.page === 0;
    this.querySelector('[data-next]').disabled = this.page === pages - 1;
    this.querySelector('[data-empty]').hidden = ranked.length > 0;
    this.querySelector('[data-empty] strong').textContent=replayView?say('当前筛选还没有完成逐谱精算','No chart replay is complete for this selection'):ui('这次没有找到匹配的谱面');
    this.querySelector('[data-empty] p').textContent=replayView?say('点击“开始逐谱精算”，或切回“全部筛选结果”继续比较。','Start chart replay, or switch to all filtered results to continue comparing.'):say('换个关键词，或放宽难度、等级和时长筛选。','Try another search or relax the difficulty, level or duration filters.');
    const picks = this.querySelector('[data-picks]'); picks.replaceChildren();
    if(gradeView){
      const valid=ranked.filter(r=>r.requiredPower!=null),best=valid[0],short=[...valid].filter(r=>Number.isFinite(r.durationSeconds)).sort((a,b)=>a.durationSeconds-b.durationSeconds||a.requiredPower-b.requiredPower)[0];
      if(best)picks.append(this.pick(best,'score',say('参考综合力最低','Lowest estimated power'),say(`约 ${number(best.displayPower)}`,`Approx. ${number(best.displayPower)}`),say(`达到 ${SCORE_GRADES[best.targetRank-2]} 档需 ${number(best.targetScore)} 分`,`${number(best.targetScore)} points to reach grade ${SCORE_GRADES[best.targetRank-2]}`)));
      if(short)picks.append(this.pick(short,'efficiency',say('短歌参考','Short-song reference'),say(`${number(short.durationSeconds,2)} 秒`,`${number(short.durationSeconds,2)} sec`),say(`同一技能口径，达档综合力约 ${number(short.displayPower)}`,`Same skills; estimated power ${number(short.displayPower)}`)));
    }else if (ranked.some(row => Number.isFinite(row.expectedScore))) {
      picks.append(this.pick(byScore[0], 'score', replayView?say('本次精算平均分最高','Highest replay mean'):custom?say('平均参考分最高','Highest estimated mean'):say('单局高分','Highest score per play'), say(`${number(maxScore)} 分`, `${number(maxScore)} points`), say(`当前条件下，平均出分最高${byScore[1]?.expectedScore === maxScore ? '（并列）' : ''}`, `Highest mean score for these conditions${byScore[1]?.expectedScore === maxScore ? ' (tied)' : ''}`)));
      if (byEfficiency.length) picks.append(this.pick(byEfficiency[0], 'efficiency', say('单位时间更快', 'Higher score per second'), say(`${number(maxEfficiency)} 分 / 秒`, `${number(maxEfficiency)} points / sec`), byEfficiency[0].id === byScore[0].id ? say('这张谱面同时领跑出分与效率', 'This chart leads both score and efficiency') : say(`按${timing.durationBasis === 'chart' ? '谱面' : '音频'}时长，得分更紧凑${byEfficiency[1]?.efficiency === maxEfficiency ? '（并列）' : ''}`, `Higher score per ${timing.durationBasis === 'chart' ? 'chart' : 'audio'} second${byEfficiency[1]?.efficiency === maxEfficiency ? ' (tied)' : ''}`)));
      else picks.append(node('div', say('当前筛选缺少有效时长，无法比较效率。', 'No valid duration is available for efficiency comparison.'), 'ranking-pick ranking-pick--empty'));
    }
    const factorKey = ['expectedScore','efficiency'].includes(this.metric) ? 'scoreMultiplier' : this.metric;
    this.querySelector('[data-factor-heading]').textContent = gradeView?'输入分数对应档位':metricLabel(factorKey);
    const body = this.querySelector('[data-rows]'); body.replaceChildren();
    for (const row of ranked.slice(this.page * size, (this.page + 1) * size)) {
      const tr = node('tr'); if (row.rank > 0 && row.rank <= 3) tr.dataset.podium = String(row.rank);
      tr.append(node('td', row.rank === null ? '—' : String(row.rank).padStart(2, '0'), 'ranking-position'));
      const song = node('td', '', 'ranking-song'), face = node('div', '', 'ranking-track');
      const jacket = this.data.artwork[row.trackId];
      if (jacket) { const img = node('img'); img.src = jacket; img.alt = ''; img.width = img.height = 48; img.loading = 'lazy'; face.append(img); }
      const title = node('div'); title.append(node('strong', row.title));
      const subtitle = node('div', '', 'ranking-subtitle'), badge = node('span', row.difficulty.toUpperCase(), 'ranking-difficulty'); badge.dataset.difficulty = row.difficulty;
      subtitle.append(badge, node('span', `Lv.${row.level}`), node('small', row.bandLabels.join(' / '))); title.append(subtitle); face.append(title); song.append(face); tr.append(song);
      if(gradeView){
        const power=node('td','','ranking-meter ranking-meter--score');power.append(node('small','参考综合力'),node('strong',row.displayPower==null?'暂不可估算':`约 ${number(row.displayPower)}`));tr.append(power);
        const threshold=node('td','','ranking-meter ranking-meter--efficiency');threshold.append(node('small',`${SCORE_GRADES[row.targetRank-2]} 档分数线`),node('strong',number(row.targetScore)));tr.append(threshold);
        const actual=node('td','','ranking-factor');actual.append(node('small','输入分数判档'),node('strong',row.enteredRank==null?'未填分数':`${SCORE_GRADES[row.enteredRank-2]} 档`));tr.append(actual);
      }else{
      tr.append(this.meter(row.expectedScore, maxScore, 'score', scoreLabel, this.metric === 'expectedScore'));
      tr.append(this.meter(row.efficiency, maxEfficiency, 'efficiency', '每秒得分', this.metric === 'efficiency'));
      const factor = node('td', '', 'ranking-factor'); factor.append(node('small', metricLabel(factorKey)), node('strong', metricValue(factorKey, row[factorKey]))); tr.append(factor);
      }
      const action = node('td', '', 'ranking-action'), button = node('button', this.expanded.has(row.id) ? '−' : '+'); button.type = 'button';
      button.setAttribute('aria-label', `查看 ${row.title} ${row.difficulty} 的${gradeView?'分档':'倍率'}明细`); button.setAttribute('aria-expanded', String(this.expanded.has(row.id)));
      const detail = node('tr', '', 'ranking-detail'); detail.hidden = !this.expanded.has(row.id); detail.id = `detail-${row.id}`; button.setAttribute('aria-controls', detail.id);
      const content = node('td'); content.colSpan = 6; this.detail(content, row); detail.append(content);
      button.addEventListener('click', () => { detail.hidden = !detail.hidden; detail.hidden ? this.expanded.delete(row.id) : this.expanded.add(row.id); button.textContent = detail.hidden ? '+' : '−'; button.setAttribute('aria-expanded', String(!detail.hidden)); });
      action.append(button); tr.append(action); body.append(tr, detail);
    }
    // Profile/FPS changes can reset the replay select during rendering.
    this.shortcuts?.sync();
  }
  meter(value, max, type, label, active) {
    const td = node('td', '', `ranking-meter ranking-meter--${type}`); if (active) td.dataset.active = '';
    td.append(node('small', label), node('strong', number(value, 2)));
    const track = node('div', '', 'ranking-meter-track'), bar = node('span'); bar.style.width = `${Number.isFinite(value) ? Math.max(0, Math.min(100, value / max * 100)) : 0}%`; track.setAttribute('aria-hidden', 'true'); track.append(bar); td.append(track); return td;
  }
  pick(row, type, label, value, note) {
    const card = node('article', '', `ranking-pick ranking-pick--${type}`), art = node('div', '', 'ranking-pick-art');
    if (this.data.artwork[row.trackId]) { const img = node('img'); img.src = this.data.artwork[row.trackId]; img.alt = ''; art.append(img); }
    art.append(node('span', type === 'score' ? 'SCORE' : 'TEMPO')); card.append(art);
    const text = node('div', '', 'ranking-pick-copy'); text.append(node('span', label, 'ranking-pick-label'), node('h3', row.title), node('small', `${row.difficulty.toUpperCase()} · Lv.${row.level}`), node('strong', value));
    text.append(node('p', note)); card.append(text); return card;
  }
  detail(root, row) {
    this.songLinks(root,row);
    if(this.metric==='requiredPower'){
      root.append(node('p',`${row.title} · ${row.difficulty.toUpperCase()} / 分档明细`,'ranking-detail-title'));
      const dl=node('dl');for(const r of row.thresholds??[]){const pair=node('div');pair.append(node('dt',`${SCORE_GRADES[r.rank-2]} 档`),node('dd',`${number(r.score)} 分`));dl.append(pair);}root.append(dl);
      if(row.targetGap!=null)root.append(node('p',row.targetGap?`输入分数距离目标还差 ${number(row.targetGap)} 分`:'输入分数已达到目标档位'));
      if(row.requiredPower==null)root.append(node('p','缺少已验证的基准得分、技能窗口或完整分档线，暂不估算综合力。'));
      const skillDl=node('dl');
      for(const [label,value] of [['基准综合力',number(row.benchmark?.power)],['无技能基准分',number(row.baseScore)],['当前技能基准分',number(row.benchmarkScore)],['全曲技能增分',row.benchmarkScore==null?'—':`${number(row.benchmarkScore-row.baseScore)}（+${number((row.benchmarkScore/row.baseScore-1)*100,2)}%）`]]){const pair=node('div');pair.append(node('dt',label),node('dd',value));skillDl.append(pair);}
      root.append(node('p','当前技能条件如何影响本曲','ranking-detail-title'),skillDl);
      if(row.skillReference)root.append(node('p',`五次发动位置：${row.skillReference.startsSeconds.map(t=>number(t,2)+' 秒').join(' / ')}。按理想发动时机估算。`));
      this.distributionDetail(root,row);
    this.activationDetail(root,row);
      const currentEdition=location.pathname.startsWith('/jp/')?'jp':'global';
      const linkReference=row.gradeReferences?.[currentEdition]??row.gradeReference;
      const edition=linkReference?.edition,locale=document.documentElement.lang||'zh-CN';
      if(linkReference?.trackId){
        const params=new URLSearchParams({song:linkReference.trackId,difficulty:row.difficulty});
        const server=new URLSearchParams(location.search).get('server');if(server&&(edition==='jp'?server==='jp':server.startsWith('global-')))params.set('server',server);
        const verify=node('a','用我的队伍估分 →');verify.href=`/${edition}/${locale}/tools/ap-grade/?${params}`;root.append(verify);
        if(row.enteredRank!=null&&JSON.stringify(linkReference.thresholds)===JSON.stringify(row.gradeReference.thresholds))params.set('scoreRank',String(row.enteredRank));
        params.set('eventMode','ordinary');const event=node('a','带歌曲到活动收益 →');event.href=`/${edition}/${locale}/tools/event-efficiency/?${params}`;root.append(node('span',' · '),event);
      }
      return;
    }
    root.append(node('p', `${row.title} · ${row.difficulty.toUpperCase()} / 得分拆解`, 'ranking-detail-title'));
    const values = [['难度倍率', metricValue('difficultyFactor', row.difficultyFactor)], ['加权连击倍率', metricValue('comboFactor', row.comboFactor)],
      ['普通技能增益', metricValue('skillMultiplier', row.skillMultiplier)], ['换算音符数', number(row.convertedNoteCount)],
      ['谱面 / 音频时长', `${number(row.chartSeconds, 2)} / ${number(row.audioSeconds, 2)} 秒`], ['无技能普通基础分', number(row.baseScore)], ['普通技能净增分', number(row.skillScoreGain, 2)], ['判定数量', number(row.eventCount)]];
    if (row.sections) values.push(['激奏 / 普通倍率', metricValue('gekisouMultiplier', row.gekisouMultiplier)], ['名次奖励占比', metricValue('rankingBonusShare', row.rankingBonusShare)], ['样本范围', `${number(row.minimumScore)} – ${number(row.maximumScore)}`], ['样本数 / 标准误', `${row.sampleCount} / ${number(row.standardError, 2)}`]);
    const dl = node('dl'); for (const [label, value] of values) { const pair = node('div'); pair.append(node('dt', label), node('dd', value)); dl.append(pair); } root.append(dl);
    if(row.meta){
      const m=row.meta,meta=node('dl','','ranking-meta');
      for(const [label,value] of [['BPM',m.bpmMin===m.bpmMax?number(m.bpmMin,2):`${number(m.bpmMin,2)}–${number(m.bpmMax,2)}`],['平均判定密度',`${number(m.averageDensity,2)} 次 / 秒`],['最密一秒',`${number(m.peakDensity)} 次（${number(m.peakStart)}–${number(m.peakStart+1)} 秒）`],['同毫秒内判定',`${number(m.simultaneousEvents)} 次`],['滑条自动计数',`${number(m.generatedEvents)} 次`]]){const pair=node('div');pair.append(node('dt',label),node('dd',value));meta.append(pair);}
      root.append(node('p','谱面结构','ranking-detail-title'),meta,node('p','密度按计分判定统计，包含滑条自动计数；同毫秒判定按正式计分时间分组。这些数值描述谱面结构，不等于手指数或游玩难度。'));
      root.append(node('p',`五次技能发动：${m.startsSeconds.map(time=>number(time,3)+' 秒').join(' / ')}。`));
    }
    this.distributionDetail(root,row);
    this.activationDetail(root,row);
    if (row.sections) {
      const stages = node('div', '', 'ranking-stages');
      for (const s of row.sections) { const stage = node('div'); stage.append(node('span', `${['','COMBO','LUCK','JUST'][s.missionType]} / 第 ${s.index} 段`), node('strong', `+${number(s.rankingPercent)}%`), node('small', `名次奖励 ${number(s.rankingBonus)} 分 · 含奖励占全曲 ${number(s.share * 100, 1)}%`)); stages.append(stage); }
      root.append(stages, node('p', '分段百分比是该段额外奖励率，不是全曲倍率。LUCK 使用固定样本；样本范围及标准误不包含模型误差。'));
    }
  }
  activationDetail(root,row){
    if(row.replaySource){
      const profile=this.querySelector('[data-grade-profile]').value;
      const skills=this.mode==='ordinary'&&profile==='custom'?[...this.querySelectorAll('[data-skill-slot]')].map(slot=>({percent:Number(slot.querySelector('[data-skill-percent]').value),seconds:Number(slot.querySelector('[data-skill-seconds]').value)})):
        Array.from({length:5},()=>({percent:profile==='none'&&this.mode==='ordinary'?0:row.benchmark.skillPercent,seconds:row.benchmark.skillSeconds}));
      root.append(skillActivation(this,null,{mode:this.mode,ranking:{replaySource:row.replaySource,sourceId:row.sourceId,trackId:row.trackId,difficulty:row.difficulty,benchmark:row.benchmark,skills,frameRate:Number(this.querySelector('[data-replay-fps]').value)}}));
    }
  }
  distributionDetail(root,row){
    if(row.skillProfile&&!row.scoreDistribution){root.append(node('p','此谱面缺少五技能窗口数据，暂不能计算当前条件。'));return;}
    if(!row.scoreDistribution)return;
    const d=row.scoreDistribution;
    root.append(node('p',say(`${row.skillReplay?'逐谱精算':'技能顺序参考'} · P10 ${number(d.p10)} 分 · 范围 ${number(d.minimum)}–${number(d.maximum)} 分 · ${d.count} 种顺序`, `${row.skillReplay?'Chart replay':'Skill-order reference'} · P10 ${number(d.p10)} · Range ${number(d.minimum)}–${number(d.maximum)} · ${d.count} orders`)));
    if(row.skillReplay){
      const replay=row.skillReplay;
      root.append(node('p',`最高顺序：${replay.bestOrder.map(slot=>slot+1).join(' → ')}；最低顺序：${replay.worstOrder.map(slot=>slot+1).join(' → ')}（数字对应上方技能编号）。`));
      if(Number.isFinite(row.linearScore))root.append(node('p',say(`${row.comparisonLabel ?? '原列表'} ${number(row.linearScore,2)} 分；逐谱精算 ${number(d.mean,2)} 分，相差 ${number(d.mean-row.linearScore,2)} 分。`, `${row.comparisonLabel ?? 'Original list'}: ${number(row.linearScore,2)}; chart replay: ${number(d.mean,2)}; difference: ${number(d.mean-row.linearScore,2)} points.`)));
      root.append(node('p',`${replay.frameRate} FPS 理想帧时钟 · AP · 满生命 · 综合力 ${number(replay.power)}。已计算倍率浮点历史、逐音符取整和记分桶回滚；真实卡牌条件、活动与激奏加成需使用队伍计算器。精算是模型内的完整计算，范围不是实战保底。`));
    }
    if(row.positionContributions){
      const dl=node('dl');for(const [i,gain] of row.positionContributions.entries()){
        const pair=node('div');pair.append(node('dt',`第 ${i+1} 次发动 · ${number(row.skillReference?.startsSeconds[i],2)} 秒`),node('dd',`平均 +${number(gain)} 分`));dl.append(pair);
      }root.append(dl);
      root.append(node('p','贡献按五个技能轮流落在各发动位求平均；线性参考不含真实卡牌条件与逐音符重新取整。'));
    }
  }
  songLinks(root,row){
    const locale=document.documentElement.lang==='en'?'en':'zh-CN',edition=row.sourceEdition;
    const trackId=row.trackId.replace(/^(global|jp)--/,'');
    const params=new URLSearchParams({song:trackId,difficulty:row.difficulty});
    const server=new URLSearchParams(location.search).get('server');
    if(server&&(edition==='jp'?server==='jp':server.startsWith('global-')))params.set('server',server);
    const links=node('nav','','ranking-song-links');links.setAttribute('aria-label',`${row.title} 相关工具`);
    const calculator=node('a','用我的队伍计算');calculator.href=`/${edition}/${locale}/tools/song-calculator/?${params}`;
    const preview=node('a','查看这张谱面');preview.href=`/${edition}/${locale}/music/${trackId}/?${new URLSearchParams({view:'analysis',difficulty:row.difficulty})}`;
    links.append(calculator,preview);root.append(links);
  }
}
if (!customElements.get('song-ranking')) customElements.define('song-ranking', SongRanking);
