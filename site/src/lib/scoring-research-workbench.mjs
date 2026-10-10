import {setupTaskWorkbench} from './task-workbench.mjs';
import {materializeTeamAssumptions} from './workbench-team-input.mjs';
import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {refreshToolTeamGrowth,toolTeamInputState,toolTeamLabel,registerToolTeamContext, notifyToolTeamChanged, assertToolTeamCompatible} from './shared-team-context.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {createPersonalGrowthStore, applyPersonalGrowth} from './personal-growth-store.mjs';
import {setupCalculatorSongPicker} from './calculator-song-picker.mjs';
import { readGekisouOpponentInputs, writeGekisouOpponentInputs } from './gekisou-opponent-inputs.mjs';
import { readScoringScenarioSearch } from './scoring-rules/scenario-search.mjs';
import { toolRoute } from "./tool-route.mjs";
import {
  createTeamDraft,
  deriveTeamDraftSummary,
  parseTeamDraftSearch,
  serializeTeamDraftSearch
} from "./team-draft.mjs";
import {
  createScoringInputSnapshot,
  evaluateScoringResearch
} from "./scoring-engine.mjs";
import { resolveTgwCardRankBonus } from "./scoring-rules/tgw-card.mjs";
import { createFormationCalculator } from "./scoring-rules/formation-power.mjs";
import { setupPerformanceInput } from './performance-input.mjs';

class ScoringResearchWorkbench extends HTMLElement {
  async connectedCallback() {
    const dataNode = this.querySelector("[data-scoring-research-data]");
    if (!(dataNode instanceof HTMLScriptElement)) return;
    this.data = JSON.parse(dataNode.textContent || "{}");
    this.labels = this.data.labels;
    try {
      const {mode,scenario}=readScoringScenarioSearch(window.location.search);
      this.querySelector('[data-scoring-mode]').value=mode;
      if(scenario) {
        writeGekisouOpponentInputs(this,scenario.opponents);
        for(const [field,selector] of [['timingOffsetMs','offset'],['batches','batches'],['seed','seed'],['frameRate','fps']]) this.querySelector(`[data-gekisou-${selector}]`).value=String(scenario[field]);
        [...this.querySelectorAll('[data-gekisou-rank]')].forEach((node,i)=>node.value=String(scenario.ranks[i]));
        [...this.querySelectorAll('[data-gekisou-confirmation]')].forEach((node,i)=>node.value=String(scenario.confirmationDelayFrames[i]));
      }
    } catch(error) { this.scenarioError=error.message; }
    this.memberById = new Map(this.data.memberCards.map((card) => [card.id, card]));
    this.supportById = new Map(this.data.supportCards.map((card) => [card.id, card]));
    this.trackById = new Map(this.data.tracks.map((track) => [track.id, track]));
    const known = {
      memberCardIds: new Set(this.memberById.keys()),
      supportCardIds: new Set(this.supportById.keys()),
      musicTrackIds: new Set(this.trackById.keys())
    };
    if (this.data.vipRanks?.length) {
      known.tgwCardRanks = new Set(this.data.vipRanks.map((entry) => entry.rank));
    }
    this.known=known;
    const parsed = parseTeamDraftSearch(window.location.search, known);
    this.draft = createTeamDraft(parsed.draft);
    try{applyPersonalGrowth(this.draft,createPersonalGrowthStore({rules:this.data.formalRules,vipRanks:this.data.vipRanks}).read());}
    catch(error){parsed.issues.push({code:'personal_growth_unavailable',severity:'warning',message:`${this.labels.song.growthUnavailable}${error.message}`});}
    if(this.draft.slots.every(slot=>slot.memberCardId&&slot.supportCardId))try{const refreshed=refreshToolTeamGrowth(this.data.formalRules,this.draft,createPersonalGrowthStore({rules:this.data.formalRules,vipRanks:this.data.vipRanks}).read()?.inventory);this.draft=refreshed.draft;this.growthIsReference=toolTeamInputState(this.draft,this.known).growthIsReference;}catch(error){this.scenarioError=error.message;parsed.issues.push({code:'planning_unavailable',severity:'warning',message:error.message});}
    this.inputIssues=parsed.issues;this.inputRequest=0;this.scoreRequest=0;
    this.shortcuts=setupQuickOptions(this);
    this.querySelector('[data-score-song-picker]').open=!this.draft.selectedSongId;

    this.querySelector('[data-calculator-song]').value=this.draft.selectedSongId??'';
    this.querySelector('[data-calculator-difficulty]').value=this.draft.selectedDifficulty??'';
    for(const [selector,field] of [['[data-calculator-song]','selectedSongId'],['[data-calculator-difficulty]','selectedDifficulty']]) {
      this.querySelector(selector).addEventListener('change',event=>{this.draft[field]=event.target.value||null;this.refreshInput();});
    }
    this.songPicker=setupCalculatorSongPicker(this,{getSelection:()=>this.draft,onSelect:selection=>{
      Object.assign(this.draft,selection);
      this.querySelector('[data-score-song-picker]').open=false;
      this.querySelector('[data-calculator-song]').value=selection.selectedSongId;
      this.querySelector('[data-calculator-difficulty]').value=selection.selectedDifficulty;
      this.refreshInput();
    }});
    const recalculate=()=>{this.scenarioError=null;if(this.loadedSnapshot)this.renderSongScore(this.loadedChart,this.loadedSnapshot,this.inputIssues);this.taskWorkbench?.refresh();};
    const profileSelect=this.querySelector('[data-score-performance-profile]');
    profileSelect.value=this.draft.modifiers.performanceScenario?'saved':'legacy';
    this.savedPerformanceScenario=structuredClone(this.draft.modifiers.performanceScenario);
    profileSelect.addEventListener('change',()=>{
      if(profileSelect.value==='saved'){if(this.savedPerformanceScenario)this.draft.modifiers.performanceScenario=structuredClone(this.savedPerformanceScenario);else delete this.draft.modifiers.performanceScenario;return this.refreshInput();}
      if(profileSelect.value==='legacy')delete this.draft.modifiers.performanceScenario;
      else this.draft.modifiers.performanceScenario={profile:profileSelect.value,seed:20261004};
      this.refreshInput();
    });
    this.querySelector('[data-performance-reset]').addEventListener('click',()=>{delete this.draft.modifiers.performanceScenario;profileSelect.value='legacy';});
    this.querySelector('[data-scoring-mode]').addEventListener('change',recalculate);
    this.querySelector('[data-gekisou-scenario]').addEventListener('change',recalculate);
    this.performanceInput=setupPerformanceInput(this,{rules:this.data.formalRules,getChart:()=>this.loadedChart,recalculate,labels:this.labels.performance});
    this.teamWorkspaceCleanup=registerToolTeamContext(this, {
      data:this.data, rules:this.data.formalRules, label:toolTeamLabel('song',this.data.locale),
      getDraft:()=>this.draft, getRestrictions:()=>({}),
      invalidate:()=>{this.inputRequest++;this.scoreRequest++;this.rejectScore?.(new Error('Cancelled'));this.scoreWorker?.terminate();},
      applyDraft:draft=>{
        this.draft=createTeamDraft(draft);this.scenarioError=null;
        Object.assign(this,toolTeamInputState(this.draft,this.known));
        const profile=this.querySelector('[data-score-performance-profile]');
        profile.value=this.draft.modifiers.performanceScenario?'saved':'legacy';
        this.savedPerformanceScenario=structuredClone(this.draft.modifiers.performanceScenario);
        this.songPicker?.sync();this.refreshInput();
      }
    });
    setupTaskWorkbench(this,'score');
    await this.refreshInput();
  }

  async refreshInput() {
    this.draft=materializeTeamAssumptions(this.draft,this.data,this.teamWorkspaceContext?.inventory);
    notifyToolTeamChanged(this.teamWorkspaceContext);
    const team=this.querySelector('[data-score-team]');team.replaceChildren(createWorkbenchTeamView(this,this.draft));
    const selected=this.draft.slots.reduce((n,s)=>n+Boolean(s.memberCardId)+Boolean(s.supportCardId),0);
    this.querySelector('[data-score-team-note]').textContent=selected===10?this.labels.song.teamReady:this.labels.song.teamIncomplete.replace('{selected}',String(selected));
    if(this.growthIsReference)this.querySelector('[data-score-team-note]').textContent+=' '+this.labels.song.referenceGrowthAssumption;
    this.querySelector('[data-score-song-name]').textContent=this.draft.selectedSongId?`${this.trackById.get(this.draft.selectedSongId)?.title??''} · ${this.draft.selectedDifficulty?.toUpperCase()??''}`:this.labels.song.chooseDifficulty;

    this.scoreRequest++;this.rejectScore?.(new Error('Cancelled'));this.scoreWorker?.terminate();
    this.querySelector('[data-skill-activation]')?.replaceChildren();
    this.loadedSnapshot=null;this.loadedChart=null;
    const summary = deriveTeamDraftSummary(this.draft, {
      memberCards: this.data.memberCards,
      supportCards: this.data.supportCards,
      projections: this.data.projections
    });
    const chartSummary = this.data.charts.find((chart) =>
      chart.trackId === this.draft.selectedSongId
      && chart.difficulty === this.draft.selectedDifficulty
    ) ?? null;
    let chart = chartSummary;
    const request=++this.inputRequest;
    this.querySelector('[data-song-score]').textContent=this.labels.song.readingChart;
    if (chartSummary?.analysisDataUrl) {
      try {
        const response = await fetch(chartSummary.analysisDataUrl);
        if (response.ok) chart = { ...chartSummary, ...(await response.json()) };
      } catch {
        chart = chartSummary;
      }
    }
    if(request!==this.inputRequest)return;
    if(chart)chart={...chart,sourceReleaseId:this.data.sourceReleaseId};
    let tgwCardBonus;
    if (this.draft.modifiers.tgwCardRank && this.data.vipRanks?.length) {
      try {
        tgwCardBonus = resolveTgwCardRankBonus(
          this.data.vipRanks, this.draft.modifiers.tgwCardRank
        );
      } catch {
        // The draft validation issues are rendered below; keep the page usable.
      }
    }
    let formationPower;
    try {
      formationPower = createFormationCalculator(this.data.formalRules).calculate(this.draft,
        { sourceReleaseId: this.data.sourceReleaseId });
    } catch (error) {
      formationPower = { status: "invalid_input", error: error.message };
    }
    const snapshot = createScoringInputSnapshot({
      sourceReleaseId: this.data.sourceReleaseId,
      draft: this.draft,
      chart,
      teamSummary: summary,
      tgwCardBonus,
      formationPower
    });
    const result = evaluateScoringResearch(snapshot, this.data.evidence);
    this.render(snapshot, result, summary, this.inputIssues);
    const eventLink=this.querySelector('[data-event-efficiency-link]');
    if(eventLink)eventLink.href=toolRoute('/tools/event-efficiency/',location.pathname)+serializeTeamDraftSearch(this.draft);
    this.loadedChart=chart;this.loadedSnapshot=snapshot;
    this.performanceInput?.sync(chart);
    this.taskWorkbench?.refresh();
    this.renderSongScore(chart, snapshot, this.inputIssues);
  }

  disconnectedCallback(){this.taskWorkbench?.destroy();this.teamWorkspaceCleanup?.();this.shortcuts?.destroy();this.performanceInput?.destroy();this.inputRequest++;this.scoreRequest++;this.rejectScore?.(new Error('Cancelled'));this.scoreWorker?.terminate();}

  calculateInWorker(payload) {
    return new Promise((resolve,reject)=>{
      assertToolTeamCompatible(this.teamWorkspaceContext);
      const worker=new Worker(new URL('./song-calculation-worker.mjs',import.meta.url),{type:'module'});
      this.scoreWorker=worker;this.rejectScore=reject;
      worker.onmessage=({data})=>{worker.terminate();if(this.scoreWorker===worker){this.scoreWorker=null;this.rejectScore=null;}data.error?reject(new Error(data.error)):resolve(data.result);};
      worker.onerror=()=>{worker.terminate();reject(new Error(this.labels.song.workerFailed));};
      worker.postMessage(payload);
    });
  }

  async renderSongScore(chart, snapshot, issues) {
    this.querySelector('[data-skill-activation]')?.replaceChildren();
    this.scoreView?.renderResult(null);
    const request=++this.scoreRequest;
    this.rejectScore?.(new Error('Cancelled'));this.scoreWorker?.terminate();
    const output = this.querySelector("[data-song-score]");
    const details = this.querySelector("[data-song-score-details]");
    const trace = this.querySelector("[data-scoring-trace]");
    trace?.replaceChildren();
    this.querySelector('[data-scoring-snapshot-json]').textContent=JSON.stringify({input:snapshot,status:'pending'},null,2);
    this.querySelector('[data-scoring-input-hash]').textContent=snapshot.inputHash??'—';
    const labels = this.labels.song;
    const inputWarnings = issues.filter(issue => issue.severity === 'warning').map(issue => issue.message);
    const format = (n) => n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const interpolate = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
    this.querySelector('[data-gekisou-scenario]').hidden = this.querySelector('[data-scoring-mode]')?.value !== 'gekisou';
    this.querySelector('[data-performance-settings]').hidden = false;
    this.querySelector('[data-score-result-title]').textContent=labels.resultTitle;
    this.querySelector('[data-score-result-assumption]').textContent=labels.resultAssumption;
    this.querySelector('[data-performance-summary]').hidden=true;
    try {
      if (this.scenarioError) throw new Error(this.scenarioError);
      if (issues.some(issue => issue.severity !== 'warning')) throw new Error(labels.invalidShare);
      if (!chart?.notes?.length) throw new Error(labels.chooseChart);
      if (this.draft.slots.some(s=>!s.memberCardId||!s.supportCardId)) throw new Error(labels.completeTeam);
      output.textContent=labels.calculating;details.textContent=labels.calculatingDetail;
      if (this.querySelector('[data-scoring-mode]')?.value === 'gekisou') {
        const scenario = { timingOffsetMs:Number(this.querySelector('[data-gekisou-offset]').value),
          frameRate:Number(this.querySelector('[data-gekisou-fps]').value),opponents:readGekisouOpponentInputs(this),
          ranks:[...this.querySelectorAll('[data-gekisou-rank]')].map(n=>Number(n.value)),
          confirmationDelayFrames:[...this.querySelectorAll('[data-gekisou-confirmation]')].map(n=>Number(n.value)),
          batches:Number(this.querySelector('[data-gekisou-batches]').value),seed:Number(this.querySelector('[data-gekisou-seed]').value) };
        const performance=this.performanceInput?.value??null;
        const result = await this.calculateInWorker({mode:'gekisou',rules:this.data.formalRules,chart:{...chart,sourceReleaseId:this.data.sourceReleaseId},scenario,draft:this.draft,performance});
        if(request!==this.scoreRequest)return;
        output.textContent = format(result.expectedScore);
        if(result.performanceScenario)this.querySelector('[data-score-result-assumption]').textContent=labels.savedPerformanceAssumption;
        this.querySelector('[data-skill-activation]').replaceChildren(skillActivation(this,this.draft,{result}));
      this.scoreView?.renderResult(result);
        details.textContent = interpolate(labels.gekisouEstimate, {power:format(result.power),samples:result.sampleCount,min:format(result.minimumScore),max:format(result.maximumScore),error:format(result.standardError),share:format(result.rankingBonusShare*100)});
        if (inputWarnings.length) details.textContent += ' ' + inputWarnings.join(' ');
        const distribution=result.scoreDistribution;
        if(distribution)details.textContent+=' '+interpolate(distribution.kind==='seed_samples'?labels.samplePercentiles:labels.orderPercentiles,{p10:format(distribution.p10),p50:format(distribution.p50),p90:format(distribution.p90)});
        const names = {1:'COMBO',2:'LUCK',3:'JUST'};
        for (const section of result.sections) {
          const item = document.createElement('li');
          item.textContent = interpolate(labels.gekisouSectionScore, {index:section.index,mission:names[section.missionType],notes:format(section.noteScore),rank:format(section.rank),bonus:format(section.rankingBonus),share:format(section.share*100),just:format(section.rawJust),combo:format(section.combo),luck:format(section.luckPoints)});
          trace?.append(item);
        }
        for (const warning of result.warnings) { const item=document.createElement('li');item.textContent=warning;trace?.append(item); }
        this.querySelector('[data-scoring-input-hash]').textContent = result.inputHash;
        this.querySelector('[data-scoring-snapshot-json]').textContent = JSON.stringify({input:snapshot,result},null,2);
        return;
      }
      const performance=this.performanceInput?.value??null;
      const result = await this.calculateInWorker({mode:'ordinary',rules:this.data.formalRules,chart:{...chart,sourceReleaseId:this.data.sourceReleaseId},draft:this.draft,performance});
      if(request!==this.scoreRequest)return;
      output.textContent = format(result.expectedScore);
      if(result.performanceScenario)this.querySelector('[data-score-result-assumption]').textContent=labels.savedPerformanceAssumption;
      this.querySelector('[data-skill-activation]').replaceChildren(skillActivation(this,this.draft,{result}));
      this.scoreView?.renderResult(result);
      const comboSummary = this.querySelector("[data-scoring-event-count]");
      if (comboSummary) comboSummary.textContent = String(result.chart.eventCount);
      details.textContent = interpolate(performance?labels.replayBreakdown:labels.breakdown, { base: format(result.baseScore), gain: format(result.skillScoreGain), min: format(result.minimumScore), max: format(result.maximumScore) });
      if(performance){
        this.querySelector('[data-score-result-title]').textContent=labels.replayTitle;
        this.querySelector('[data-score-result-assumption]').textContent=labels.replayAssumption;
        const state=result.performance;
        const summary=this.querySelector('[data-performance-summary]');
        summary.textContent=interpolate(labels.replayState,{combo:format(state.maxCombo),life:format(state.life),lowest:format(state.lowestLife),miss:format(state.judgementCounts[1]),bad:format(state.judgementCounts[2]),converted:format(state.convertedCount)});
        summary.hidden=false;
      }
      if (inputWarnings.length) details.textContent += ' ' + inputWarnings.join(' ');
      const messages = [
        performance?labels.replayScenario:labels.scenario,
        performance?labels.replayOrder:interpolate(labels.orderPercentiles,{p10:format(result.scoreDistribution.p10),p50:format(result.scoreDistribution.p50),p90:format(result.scoreDistribution.p90)}),
        interpolate(labels.topology, { events: result.chart.eventCount, master: result.chart.masterFullCombo }),
        interpolate(labels.factors, { power: format(result.power), factor: result.chart.difficultyFactor.toFixed(3), notes: result.chart.convertedNoteCount }),
        ...result.skills.map((skill) => interpolate(labels.skill, { slot: skill.slotIndex + 1, member: skill.memberLevel, support: skill.supportLevels.join(" / "), duration: skill.extensionMs })),
        ...result.warnings
      ];
      for (const message of messages) {
        const item = document.createElement("li"); item.textContent = message; trace?.append(item);
      }
      this.querySelector("[data-scoring-input-hash]").textContent = result.inputHash;
      this.querySelector("[data-scoring-snapshot-json]").textContent = JSON.stringify({ input: snapshot, ...(performance?{performance}:{}), result }, null, 2);
      this.scoreView?.refresh();
    } catch (error) {
      if(request!==this.scoreRequest)return;
      output.textContent = labels.unavailable;
      details.textContent = error.message;
      this.querySelector('[data-scoring-snapshot-json]').textContent=JSON.stringify({input:snapshot,status:'unavailable',error:error.message},null,2);
      const item = document.createElement("li"); item.textContent = error.message; trace?.append(item);
    }
  }

  render(snapshot, result, summary, issues) {
    const status = this.querySelector("[data-scoring-input-status]");
    const hasContext = Boolean(this.draft.selectedSongId || summary.selectedCards.length);
    if (status) {
      status.textContent = hasContext
        ? this.labels.fixed
        : this.labels.blankDraft;
    }
    const hash = this.querySelector("[data-scoring-input-hash]");
    if (hash) hash.textContent = snapshot.inputHash;
    const json = this.querySelector("[data-scoring-snapshot-json]");
    if (json) json.textContent = JSON.stringify(snapshot, null, 2);
    const optimizeLink=this.querySelector('[data-score-optimize-link]');
    if(optimizeLink)optimizeLink.href=toolRoute(`/tools/optimizer/${serializeTeamDraftSearch(this.draft)}`,window.location.pathname);
    const editLink = this.querySelector("[data-edit-scoring-draft]");
    let rankingLink = this.querySelector('[data-song-ranking-link]');
    if (!rankingLink) { rankingLink = document.createElement('a'); rankingLink.dataset.songRankingLink = ''; rankingLink.textContent = this.labels.song.rankingLink; this.querySelector('.calculator-links').append(rankingLink); }
    rankingLink.href = toolRoute('/tools/song-ranking/', window.location.pathname);
    if (editLink instanceof HTMLAnchorElement) {
      editLink.href = toolRoute(`/tools/deck-builder/${serializeTeamDraftSearch(this.draft)}`, window.location.pathname);
    }

    const summaryNode = this.querySelector("[data-scoring-input-summary]");
    if (summaryNode) {
      const track = this.trackById.get(this.draft.selectedSongId);
      const values = [
        [this.labels.power, snapshot.formationPower?.total?.total?.toLocaleString() ?? this.labels.invalidInput, false],
        [
          this.labels.fields.track,
          track?.title ?? this.labels.notSelected,
          Boolean(track)
        ],
        [
          this.labels.fields.difficulty,
          this.draft.selectedDifficulty?.toUpperCase() ??
            this.labels.notSelected,
          false
        ],
        [this.labels.fields.cards, String(summary.selectedCards.length), false],
        [
          this.labels.fields.tgwCard,
          snapshot.tgwCardBonus
            ? `R${snapshot.tgwCardBonus.rank} · ${snapshot.tgwCardBonus.rawValue / 100}%`
            : this.labels.notSelected,
          false
        ],
        [
          this.labels.fields.noteObjects,
          snapshot.chart?.noteObjectCount === null ? this.labels.chartUnavailable : String(snapshot.chart?.noteObjectCount ?? 0),
          false
        ],
        [
          this.labels.fields.fullCombo,
          String(snapshot.chart?.fullComboCount ?? 0),
          false
        ]
      ];
      summaryNode.replaceChildren(...values.map(([label, value, entity]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const definition = document.createElement("dd");
        term.textContent = label;
        definition.textContent = value;
        if (label === this.labels.fields.fullCombo) definition.dataset.scoringEventCount = "";
        if (entity) definition.dataset.uiEntity = "";
        row.append(term, definition);
        return row;
      }));
    }

    const trace = this.querySelector("[data-scoring-trace]");
    if (trace) {
      trace.replaceChildren();
      if (issues.length > 0) {
        issues.forEach((entry) => {
          const item = document.createElement("li");
          item.dataset.status = "rejected";
          item.textContent =
            this.labels.issues[entry.code] ?? entry.code;
          trace.append(item);
        });
      }
      result.trace.forEach((entry) => {
        const item = document.createElement("li");
        item.dataset.status = entry.status;
        const label = document.createElement("strong");
        label.textContent = entry.stage.toUpperCase();
        const copy = document.createElement("span");
        copy.textContent = this.labels.trace[entry.code] ?? entry.code;
        item.append(label, copy);
        trace.append(item);
      });
    }
  }
}

if (!customElements.get("scoring-research-workbench")) {
  customElements.define("scoring-research-workbench", ScoringResearchWorkbench);
}
