import {createPersonalGrowthStore,applyPersonalGrowth} from './personal-growth-store.mjs';
import {toolTeamLabel,registerToolTeamContext, notifyToolTeamChanged} from './shared-team-context.mjs';
import {skillPeek,destroySkillPopover} from './calculator-card-ui.mjs';
import {setupCalculatorSongPicker} from './calculator-song-picker.mjs';
import {setupCalculatorJourney} from './calculator-journey.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {attributeBadge} from './calculator-attribute-ui.mjs';

  import { resolveTgwCardRankBonus } from "./scoring-rules/tgw-card.mjs";
  import { setupProductionPower } from "./production-power-ui.mjs";
  import {
    createTeamDraft,
    deriveTeamDraftSummary,
    parseTeamDraftSearch,
    serializeTeamDraftSearch,
    serializeTeamDraftJson,
    validateTeamDraft
  } from "./team-draft.mjs";

  class TeamDraftWorkbench extends HTMLElement {
    connectedCallback() {
      const dataNode = this.querySelector("[data-team-draft-data]");
      if (!(dataNode instanceof HTMLScriptElement)) return;
      this.data = JSON.parse(dataNode.textContent || "{}");
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
      const parsed = parseTeamDraftSearch(window.location.search, this.known);
      this.draft = parsed.draft;
      try{applyPersonalGrowth(this.draft,createPersonalGrowthStore({rules:this.data.formalRules,vipRanks:this.data.vipRanks}).read());}catch(error){this.profileError=error.message;}
      this.parseIssues = parsed.issues.filter((issue) => issue.code === "invalid_modifiers");
      this.activeSlot = 0;
      this.pickerKind = "member";
      this.productionPower = setupProductionPower(this);

      this.bindEvents();
      this.songPicker=setupCalculatorSongPicker(this,{getSelection:()=>this.draft,onSelect:selection=>{Object.assign(this.draft,selection);this.commit();}});
      this.journey=setupCalculatorJourney(this);
      this.quickOptions=setupQuickOptions(this);
      this.render();
      this.teamWorkspaceCleanup = registerToolTeamContext(this, {
        data:this.data, rules:this.data.formalRules, label:toolTeamLabel('deck',this.data.locale),
        getDraft:()=>this.draft, getRestrictions:()=>({}),
        invalidate:()=>this.productionPower?.changed(),
        applyDraft:draft=>{this.draft=createTeamDraft(draft);this.planningScenarios?.restore(this.draft.modifiers);this.commit();},
        onInventoryChange:()=>this.planningScenarios?.refreshInventory()
      });
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
      this.querySelector("[data-tgw-rank-select]")?.addEventListener("change", (event) => {
        if (event.target.value) {
          this.draft.modifiers.tgwCardRank = Number(event.target.value);
        } else {
          delete this.draft.modifiers.tgwCardRank;
        }
        this.commit();
      });
    }

    cardFor(kind, id) {
      if (!id) return null;
      return kind === "member" ? this.memberById.get(id) : this.supportById.get(id);
    }

    cardFace(kind, id, slotIndex = this.activeSlot) {
      const card = this.cardFor(kind, id);
      const face = document.createElement("div");
      face.className = `team-slot-card team-slot-card--${kind}`;
      if (!card) {
        face.classList.add("is-empty");
        const label = id
          ? `${this.labels.unknownPrefix}${id}`
          : kind === "member"
            ? this.labels.selectMember
            : this.labels.selectSupport;
        face.textContent = label;
        return face;
      }
      if (card.imageUrl) {
        const image = document.createElement("img");
        image.src = card.imageUrl;
        image.alt = "";
        face.append(image);
      }
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = card.shortLabel;
      name.dataset.uiEntity = "";
      const relation = document.createElement("small");
      relation.textContent = card.relationLabel || card.displayName;
      relation.dataset.uiEntity = "";
      copy.append(name, relation, attributeBadge(card.attributeCode, this.data.attributeVisuals));
      face.append(copy);
      face.append(skillPeek(this,card,{growth:this.draft.modifiers.growth?.[id],leader:slotIndex===2},face));
      return face;
    }

    renderSlots() {
      const container = this.querySelector("[data-team-slots]");
      if (!container) return;
      container.replaceChildren();
      this.draft.slots.forEach((slot, index) => {
        const button = document.createElement("article");
        button.className = "team-slot";
        button.classList.toggle("is-active", index === this.activeSlot);

        const number = document.createElement("button");
        number.type="button";number.setAttribute("aria-pressed",String(index===this.activeSlot));number.setAttribute("aria-label",`${this.labels.editSlot} ${index+1}${index===2?` ${this.labels.leader}`:""}`);
        number.className = "team-slot-number";
        number.textContent = index === 2 ? `03 · ${this.labels.leader}` : String(index + 1).padStart(2, "0");
        const cards = document.createElement("span");
        cards.className = "team-slot-pair";
        cards.append(
          this.cardFace("member", slot.memberCardId,index),
          this.cardFace("support", slot.supportCardId,index)
        );
        button.append(number, cards);
        number.addEventListener("click", () => {
          this.activeSlot = index;
          this.renderSlots();
          this.renderPickerState();
          this.productionPower?.settings();
        });
        container.append(button);
      });
    }

    renderPickerState() {
      const label = this.querySelector("[data-active-slot-label]");
      if (label) label.textContent = String(this.activeSlot + 1).padStart(2, "0");
      this.cardPicker?.sync();
    }

    filterCards() { this.cardPicker?.sync(); }

    renderDraft() {
      const song = this.querySelector("[data-song-select]");
      if (song) song.value = this.draft.selectedSongId || "";
      const difficulty = this.querySelector("[data-difficulty-select]");
      if (difficulty) difficulty.value = this.draft.selectedDifficulty || "";
      const tgwRank = this.querySelector("[data-tgw-rank-select]");
      if (tgwRank) tgwRank.value = String(this.draft.modifiers.tgwCardRank ?? "");
      const tgwNote = this.querySelector("[data-tgw-bonus-note]");
      if (tgwNote && this.draft.modifiers.tgwCardRank) {
        try {
          const bonus = resolveTgwCardRankBonus(
            this.data.vipRanks, this.draft.modifiers.tgwCardRank
          );
          tgwNote.textContent = this.labels.tgwBonus.replace("{rank}", bonus.rank)
            .replace("{percent}", bonus.rawValue / 100).replace("{bp}", bonus.rawValue);
        } catch {
          tgwNote.textContent = this.labels.issues.invalid_tgw_card_rank;
        }
      } else if (tgwNote) {
        tgwNote.textContent = this.labels.tgwDefault;
      }
    }

    commit() {
      this.productionPower?.changed();
      this.draft = createTeamDraft(this.draft);
      const query = serializeTeamDraftSearch(this.draft);
      window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
      this.render();
      notifyToolTeamChanged(this.teamWorkspaceContext);
    }

    render() {
      this.renderSlots();
      this.renderPickerState();
      this.renderDraft();
      this.productionPower?.settings();
      this.songPicker?.sync();
      this.journey?.refresh();
      this.quickOptions?.sync();
    }

    disconnectedCallback() { this.teamWorkspaceCleanup?.(); destroySkillPopover(this); this.productionPower?.disconnect(); this.journey?.disconnect(); this.quickOptions?.destroy(); }
  }

  if (!customElements.get("team-draft-workbench")) {
    customElements.define("team-draft-workbench", TeamDraftWorkbench);
  }
