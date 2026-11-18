import {formatRankingCell,rankingMetricExplanation} from './song-ranking-table.mjs';
import {rankingSongLinks,editionName} from './song-ranking-options.mjs';
import {rankingSongCover} from './ranking-song-cover.mjs';

// Compact ranking details. Scoring, replay and account state remain owned by their tools.
export function renderRankingDetail(root,row,{mode='ordinary',locale='zh-CN',server,edition,artwork,openChart}={}) {
  const doc=root.ownerDocument,en=locale.startsWith('en'),say=(zh,english)=>en?english:zh;
  const make=(tag,text='',cls='')=>{const el=doc.createElement(tag);el.textContent=text;el.className=cls;return el;};
  const number=(n,digits=0)=>Number.isFinite(n)?n.toLocaleString(locale,{maximumFractionDigits:digits}):'—';
  const cell=key=>formatRankingCell(key,row,locale);
  const heading=make('div','','ranking-detail-heading'),identity=make('div');
  identity.append(make('span',say('谱面明细','Chart details'),'ranking-detail-eyebrow'),make('strong',`${row.title} · ${row.difficulty.toUpperCase()}`));
  const links=make('nav','','ranking-song-links');links.setAttribute('aria-label',say('此谱面的相关工具','Tools for this chart'));
  const urls=rankingSongLinks(row,{edition,locale,server,mode});
  const calculator=make('a',say('队伍计算','Team calculator'));calculator.href=urls.calculator;links.append(calculator);
  const chart=make('button',say('查看谱面','View chart'));chart.type='button';if(row.id)chart.dataset.rankingChartOpen=row.id;chart.setAttribute('aria-haspopup','dialog');chart.addEventListener('click',()=>openChart?.(row,edition));links.append(chart);
  const song=make('div','','ranking-detail-song');song.append(rankingSongCover(doc,artwork,48),identity);heading.append(song,links);root.append(heading);
  const metrics=make('dl','','ranking-detail-metrics');
  const summary=[['expectedScore',say(mode==='gekisou'?'样本平均分':'平均参考分',mode==='gekisou'?'Sample mean':'Mean score')],['minimumScore',say(mode==='gekisou'?'样本最低分':'最低参考分','Minimum score')],['maximumScore',say(mode==='gekisou'?'样本最高分':'最高参考分','Maximum score')],['p10Score',say('偏低参考分 · P10','Lower score · P10')],['baseScore',say('无技能基础分','No-skill score')],['skillScoreGain',say('普通技能净增分','Ordinary skill gain')]];
  for(const [key,label] of summary){const item=make('div');item.append(make('dt',label),make('dd',cell(key)));if(key==='p10Score')item.title=rankingMetricExplanation(key,mode,en);metrics.append(item);}
  root.append(metrics);
  const starts=row.skillReference?.startsSeconds??row.meta?.startsSeconds;
  if(starts?.length){
    const section=make('section','','ranking-detail-skills'),title=make('h3',say('五次技能发动','Five skill activations'));
    section.append(title);const slots=make('ol','','ranking-skill-slots');
    starts.forEach((time,index)=>{const slot=make('li');slot.style.setProperty('--slot-color',`var(--theme-chart-${index%5+1})`);
      const top=make('div');top.append(make('b',String(index+1).padStart(2,'0')),make('strong',`${number(time,2)} s`));slot.append(top);
      const gain=row.positionContributions?.[index];
      slot.append(make('small',row.skillProfile?.every(skill=>!skill.percent||!skill.seconds)?say('无加分技能','No score skills'):Number.isFinite(gain)?say(`平均 +${number(gain)} 分`,`Mean +${number(gain)}`):row.skillProfile?say('遍历技能顺序','Compare skill orders'):say(`+${number(row.benchmark?.skillPercent)}% · ${number(row.benchmark?.skillSeconds,2)} s`,`+${number(row.benchmark?.skillPercent)}% · ${number(row.benchmark?.skillSeconds,2)} s`)));
      slots.append(slot);
    });section.append(slots);root.append(section);
  }
  if(row.sections?.length){
    const section=make('section','','ranking-detail-gekisou');section.append(make('h3',say('激奏分段奖励','Gekisou section rewards')));
    const stages=make('div','','ranking-stages');
    for(const part of row.sections){const stage=make('article');stage.dataset.mission=String(part.missionType);
      const title=make('div');title.append(make('span',say(`第 ${part.index} 段`,`Section ${part.index}`)),make('b',['','COMBO','LUCK','JUST'][part.missionType]??'—'));
      stage.append(title,make('strong',`+${number(part.rankingPercent,2)}%`),make('small',say(`名次奖励 ${number(part.rankingBonus)} 分 · 本段总分占全曲 ${number(part.share*100,1)}%`,`Rank reward ${number(part.rankingBonus)} · Section total is ${number(part.share*100,1)}% of overall score`)));stages.append(stage);
    }section.append(stages);root.append(section);
  }
  const notes=make('div','','ranking-detail-notes');
  if(row.meta){
    const details=make('details'),m=row.meta;details.append(make('summary',say('谱面结构','Chart structure')));
    const grid=make('dl','','ranking-detail-structure');
    for(const [label,value] of [[say('BPM','BPM'),m.bpmMin===m.bpmMax?number(m.bpmMin,2):`${number(m.bpmMin,2)}–${number(m.bpmMax,2)}`],[say('平均判定密度','Average density'),`${number(m.averageDensity,2)} / s`],[say('最密一秒','Peak second'),`${number(m.peakDensity)} · ${number(m.peakStart,2)}–${number(m.peakStart+1,2)} s`],[say('同毫秒判定','Simultaneous events'),number(m.simultaneousEvents)],[say('滑条自动计数','Generated slide ticks'),number(m.generatedEvents)]]){const item=make('div');item.append(make('dt',label),make('dd',value));grid.append(item);}
    details.append(grid,make('p',say('密度包含滑条自动计数，描述计分结构，不等于手指数或游玩难度。','Density includes generated slide ticks and describes scoring structure, not finger count or playing difficulty.')));notes.append(details);
  }
  const provenance=make('details');provenance.append(make('summary',say('计算口径与来源','Calculation & sources')));
  provenance.append(make('p',say('固定综合力 100,000，AP、满生命。工具跳转保留歌曲、难度和兼容区服；手填技能不替代真实账号编成与养成。','Fixed 100,000 power, AP and full life. Links preserve the song, difficulty and compatible server; entered skills do not replace account teams or growth.')));
  provenance.append(make('p',`${say('分数适用','Scores valid for')}：${cell('editionLabel')} · ${cell('calculationState')}`));
  for(const [key,ref] of Object.entries(row.editionChartReferences??row.gradeReferences??{}))if(ref.sourceReleaseId)provenance.append(make('p',`${editionName(key,en)} · ${ref.sourceReleaseId}`,'ranking-source-release'));
  if(row.scoreDistribution){const d=row.scoreDistribution;provenance.append(make('p',say(`${d.count} 种技能顺序 · 范围 ${number(d.minimum)}–${number(d.maximum)} 分。位置收益按技能轮换求平均。`,`${d.count} skill orders · ${number(d.minimum)}–${number(d.maximum)} points. Position contributions average over skill orders.`)));}
  if(row.skillProfile&&!row.scoreDistribution)provenance.append(make('p',say('此谱面缺少五技能窗口数据，暂不能计算当前条件。','This chart lacks skill-window data for the current conditions.')));
  provenance.append(make('p',rankingMetricExplanation('p10Score',mode,en)));
  if(row.skillReplay){const replay=row.skillReplay;provenance.append(make('p',say(`最高顺序 ${replay.bestOrder.map(slot=>slot+1).join('、')} · 最低顺序 ${replay.worstOrder.map(slot=>slot+1).join('、')} · ${replay.frameRate} FPS`,`Best order ${replay.bestOrder.map(slot=>slot+1).join(', ')} · Worst order ${replay.worstOrder.map(slot=>slot+1).join(', ')} · ${replay.frameRate} FPS`)));
    if(Number.isFinite(row.linearScore))provenance.append(make('p',say(`快速估算 ${number(row.linearScore,2)} 分 · 精算 ${number(row.scoreDistribution?.mean,2)} 分 · 差 ${number(row.scoreDistribution?.mean-row.linearScore,2)} 分`,`Quick estimate ${number(row.linearScore,2)} · Replay ${number(row.scoreDistribution?.mean,2)} · Difference ${number(row.scoreDistribution?.mean-row.linearScore,2)}`)));
  }
  if(row.sections)provenance.append(make('p',say(`激奏固定 LUCK 样本 ${number(row.sampleCount)} 个，标准误 ${number(row.standardError,2)} 分。分段百分比为该段额外奖励率；样本范围与标准误不包含模型误差。`,`Gekisou uses ${number(row.sampleCount)} fixed LUCK samples, standard error ${number(row.standardError,2)}. Section percentages are extra reward rates; sample ranges and standard error exclude model error.`)));
  notes.append(provenance);root.append(notes);
}
