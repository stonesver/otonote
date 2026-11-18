import {readToolJson} from '../runtime/tool-startup.mjs';
import {setupTaskWorkbench} from './task-workbench.mjs';
import {createPersonalGrowthStore,applyPersonalGrowth} from './personal-growth-store.mjs';
import {toolTeamLabel,registerToolTeamContext, notifyToolTeamChanged} from './shared-team-context.mjs';
import {destroySkillPopover} from './calculator-card-ui.mjs';
import {setupCalculatorSongPicker} from './calculator-song-picker.mjs';
import {setupTeamTaskControls} from './team-task-controls.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';

  import { setupProductionPower } from "./production-power-ui.mjs";
  import {
    createTeamDraft,
    parseTeamDraftSearch,
    serializeTeamDraftSearch
  } from "./team-draft.mjs";

  class TeamDraftWorkbench extends HTMLElement {
    connectedCallback() {
      const dataNode = this.querySelector("[data-team-draft-data]");
      if (!(dataNode instanceof HTMLScriptElement)) return;
      this.data = readToolJson(dataNode);
      this.labels = this.data.labels;
      this.memberById = new Map(this.data.memberCards.map((card) => [card.id, card]));
      this.supportById = new Map(this.data.supportCards.map((card) => [card.id, card]));
      this.known = {
        memberCardIds: new Set(this.memberById.keys()),
        supportCardIds: new Set(this.supportById.keys()),
        musicTrackIds: new Set(this.data.tracks.map((track) => track.id))
      };
      if (this.data.vipRanks?.length) {
        this.known.tgwCardRanks = new Set(this.data.vipRanks.map((entry) => entry.rank));
      }
      const parsed = parseTeamDraftSearch(window.location.search, this.known, window.location.hash);
      this.draft = parsed.draft;
      try{applyPersonalGrowth(this.draft,createPersonalGrowthStore({rules:this.data.formalRules,vipRanks:this.data.vipRanks}).read());}catch(error){this.profileError=error.message;}
      this.parseIssues = parsed.issues.filter((issue) => issue.code === "invalid_modifiers");
      this.productionPower = setupProductionPower(this);

      this.bindEvents();
      this.songPicker=setupCalculatorSongPicker(this,{getSelection:()=>this.draft,onSelect:selection=>{Object.assign(this.draft,selection);this.commit();}});
      this.taskControls=setupTeamTaskControls(this);
      this.quickOptions=setupQuickOptions(this);
      this.render();
      this.teamWorkspaceCleanup = registerToolTeamContext(this, {
        data:this.data, rules:this.data.formalRules, label:toolTeamLabel('deck',this.data.locale),
        getDraft:()=>this.draft, getRestrictions:()=>({}),
        invalidate:()=>this.productionPower?.changed(),
        applyDraft:draft=>{this.draft=createTeamDraft(draft);this.planningScenarios?.restore(this.draft.modifiers);this.commit();},
        onInventoryChange:()=>this.planningScenarios?.refreshInventory()
      });
      setupTaskWorkbench(this,'team');
    }

    bindEvents() {
      this.querySelector("[data-song-select]")?.addEventListener("change", (event) => {
        this.draft.selectedSongId = event.target.value || null;
        this.commit();
      });
      this.querySelector("[data-difficulty-select]")?.addEventListener("change", (event) => {
        this.draft.selectedDifficulty = event.target.value || null;
        this.commit();
      });
    }

    cardFor(kind, id) {
      if (!id) return null;
      return kind === "member" ? this.memberById.get(id) : this.supportById.get(id);
    }

    renderDraft() {
      const song = this.querySelector("[data-song-select]");
      if (song) song.value = this.draft.selectedSongId || "";
      const difficulty = this.querySelector("[data-difficulty-select]");
      if (difficulty) difficulty.value = this.draft.selectedDifficulty || "";
    }

    commit() {
      this.productionPower?.changed();
      this.draft = createTeamDraft(this.draft);
      const parameters=new URLSearchParams(serializeTeamDraftSearch(this.draft));
      const server=new URLSearchParams(window.location.search).get('server');if(server)parameters.set('server',server);
      const query = parameters.size?'?'+parameters.toString():'';
      window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
      this.render();
      notifyToolTeamChanged(this.teamWorkspaceContext);
    }

    render() {
      this.renderDraft();
      this.songPicker?.sync();
      this.taskControls?.refresh();
      this.quickOptions?.sync();
    }

    disconnectedCallback() {
      this.taskWorkbench?.destroy(); this.teamWorkspaceCleanup?.(); destroySkillPopover(this); this.productionPower?.disconnect(); this.taskControls?.disconnect(); this.quickOptions?.destroy(); }
  }

  if (!customElements.get("team-draft-workbench")) {
    customElements.define("team-draft-workbench", TeamDraftWorkbench);
  }
