import {scopedStorageKey, currentServerContext, assertAccountServer} from './game-servers.mjs';
import { toolRoute } from "./tool-route.mjs";
import {
  createGekisouScenario,
  runGekisouResearchSimulation
} from "./gekisou-simulation.mjs";
import {
  createTeamDraft,
  serializeTeamDraftSearch,
  serializeTeamDraftJson,
  parseScopedTeamDraftJson,
  validateTeamDraft
} from "./team-draft.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = Array.from({length:5},(_,index)=>`var(--theme-chart-${index+1})`);
const STORAGE_KEY = scopedStorageKey('gekisou-lab:v1');
const JUDGEMENT_LABELS = ["perfect", "great", "good", "hit", "miss"];

const element = (name, className, text) => {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svgElement = (name, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
};

class GekisouBattleLab extends HTMLElement {
  async connectedCallback() {
    const dataNode = this.querySelector("[data-gekisou-lab-data]");
    if (!(dataNode instanceof HTMLScriptElement)) return;
    this.data = JSON.parse(dataNode.textContent || "{}");
    this.trackById = new Map(this.data.tracks.map((track) => [track.id, track]));
    this.chartByKey = new Map(
      this.data.charts.map((chart) => [`${chart.trackId}:${chart.difficulty}`, chart])
    );
    this.memberCardById = new Map(this.data.memberCards.map((card) => [card.id, card]));
    this.supportCardById = new Map(this.data.supportCards.map((card) => [card.id, card]));
    this.skillById = new Map(this.data.skills.map((skill) => [skill.id, skill]));
    this.known = {
      memberCardIds: new Set(this.data.memberCardIds),
      supportCardIds: new Set(this.data.supportCardIds),
      musicTrackIds: new Set(this.data.tracks.map((track) => track.id))
    };
    const params = new URLSearchParams(window.location.search);
    const restored = this.restoreLocalState();
    this.trackId = params.get("song")
      ?? restored?.trackId
      ?? this.data.tracks[0]?.id
      ?? null;
    this.difficulty = params.get("difficulty")
      ?? restored?.difficulty
      ?? "expert";
    this.mode = params.get("mode")
      ?? restored?.mode
      ?? "rules";
    const requestedCount = Number(params.get("participants") ?? restored?.participants?.length ?? 1);
    this.participants = Array.isArray(restored?.participants)
      ? restored.participants.slice(0, 5).map((participant, index) => this.normalizeParticipant(participant, index))
      : [];
    this.setParticipantCount(Number.isInteger(requestedCount) ? requestedCount : 1);
    const requestedMember = params.get("member");
    const requestedSupport = params.get("support");
    if (requestedMember && this.memberCardById.has(requestedMember)) {
      this.participants[0].teamDraft.slots[0].memberCardId = requestedMember;
    }
    if (requestedSupport && this.supportCardById.has(requestedSupport)) {
      this.participants[0].teamDraft.slots[0].supportCardId = requestedSupport;
    }
    this.requestedSkillId = this.skillById.has(params.get("skill")) ? params.get("skill") : null;
    this.focusedParticipantId = restored?.focusedParticipantId
      && this.participants.some((entry) => entry.id === restored.focusedParticipantId)
      ? restored.focusedParticipantId
      : this.participants[0]?.id ?? null;
    this.overrides = Array.isArray(restored?.overrides) ? restored.overrides : [];
    this.randomSeed = Number.isInteger(restored?.randomSeed) ? restored.randomSeed : 0;
    this.luckOutcomes = Array.isArray(restored?.luckOutcomes) ? restored.luckOutcomes : [];
    this.comparisons = Array.isArray(restored?.comparisons) ? restored.comparisons.slice(0, 12) : [];
    this.bindEvents();
    this.syncControls();
    await this.loadChart();
  }

  normalizeParticipant(value, index) {
    return {
      id: typeof value?.id === "string" ? value.id : `participant-${index + 1}`,
      label: typeof value?.label === "string" ? value.label : `P${index + 1}`,
      teamDraft: createTeamDraft(value?.teamDraft),
      performancePlan: {
        preset: ["ap", "fc", "custom"].includes(value?.performancePlan?.preset)
          ? value.performancePlan.preset
          : "ap",
        segmentOverrides: Array.isArray(value?.performancePlan?.segmentOverrides)
          ? value.performancePlan.segmentOverrides.map((entry) => ({
              id: entry.id,
              segmentIndex: Number(entry.segmentIndex),
              judgement: JUDGEMENT_LABELS.includes(entry.judgement) ? entry.judgement : "hit",
              comboBreak: entry.comboBreak === true
            }))
          : [],
        noteOverrides: Array.isArray(value?.performancePlan?.noteOverrides)
          ? value.performancePlan.noteOverrides.map((entry) => ({
              id: entry.id,
              markerId: entry.markerId,
              judgement: JUDGEMENT_LABELS.includes(entry.judgement) ? entry.judgement : "hit",
              comboBreak: entry.comboBreak === true
            }))
          : []
      },
      skillBranches: Array.isArray(value?.skillBranches)
        ? value.skillBranches.map((entry, branchIndex) => ({
            id: entry.id ?? `skill-branch-${index + 1}-${branchIndex + 1}`,
            skillId: entry.skillId,
            sourceCardId: entry.sourceCardId ?? null,
            markerIndex: Number(entry.markerIndex),
            durationSeconds: Number(entry.durationSeconds ?? 0),
            experimentalScoreDelta: Number(entry.experimentalScoreDelta ?? 0),
            note: entry.note ?? null
          }))
        : []
    };
  }

  setParticipantCount(count) {
    const bounded = Math.max(1, Math.min(5, count));
    this.participants = Array.from({ length: bounded }, (_, index) =>
      this.participants[index] ?? this.normalizeParticipant({}, index)
    );
    if (!this.participants.some((entry) => entry.id === this.focusedParticipantId)) {
      this.focusedParticipantId = this.participants[0]?.id ?? null;
    }
    this.overrides = (this.overrides ?? []).filter((override) =>
      this.participants.some((participant) => participant.id === override.participantId)
    );
    this.luckOutcomes = (this.luckOutcomes ?? []).filter((outcome) =>
      this.participants.some((participant) => participant.id === outcome.participantId)
    );
  }

  restoreLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.sourceReleaseId === this.data.sourceReleaseId ? parsed : null;
    } catch {
      return null;
    }
  }

  bindEvents() {
    this.querySelector("[data-gekisou-track]")?.addEventListener("change", async (event) => {
      this.trackId = event.target.value;
      await this.loadChart();
    });
    this.querySelector("[data-gekisou-difficulty]")?.addEventListener("change", async (event) => {
      this.difficulty = event.target.value;
      await this.loadChart();
    });
    this.querySelector("[data-gekisou-participant-count]")?.addEventListener("change", (event) => {
      this.setParticipantCount(Number(event.target.value));
      this.render();
    });
    this.querySelector("[data-gekisou-mode]")?.addEventListener("change", (event) => {
      this.mode = event.target.value;
      this.render();
    });
    this.querySelector("[data-gekisou-random-seed]")?.addEventListener("change", (event) => {
      const value = Number(event.target.value);
      this.randomSeed = Number.isInteger(value) ? value : 0;
      this.render();
    });
    this.querySelector("[data-gekisou-participant-label]")?.addEventListener("change", (event) => {
      const participant = this.focusedParticipant();
      if (participant) participant.label = event.target.value.trim() || participant.id;
      this.render();
    });
    this.querySelector("[data-gekisou-performance-preset]")?.addEventListener("change", (event) => {
      const participant = this.focusedParticipant();
      if (participant) participant.performancePlan.preset = event.target.value;
      this.render();
    });
    this.querySelector("[data-gekisou-apply-team]")?.addEventListener("click", () => this.applyTeamDraft());
    this.querySelector("[data-gekisou-add-note-override]")?.addEventListener("click", () => this.addNoteOverride());
    this.querySelector("[data-gekisou-add-skill]")?.addEventListener("click", () => this.addSkillBranch());
    this.querySelector("[data-gekisou-add-override]")?.addEventListener("click", () => this.addOverride());
    this.querySelector("[data-gekisou-copy-scenario]")?.addEventListener("click", () => this.copyScenario());
    this.querySelector("[data-gekisou-import-scenario]")?.addEventListener("click", () => this.importScenario());
    this.querySelector("[data-gekisou-save-comparison]")?.addEventListener("click", () => this.saveComparison());
  }

  syncControls() {
    const setValue = (selector, value) => {
      const node = this.querySelector(selector);
      if (node) node.value = value ?? "";
    };
    setValue("[data-gekisou-track]", this.trackId);
    setValue("[data-gekisou-difficulty]", this.difficulty);
    setValue("[data-gekisou-participant-count]", String(this.participants.length));
    setValue("[data-gekisou-mode]", this.mode);
    setValue("[data-gekisou-random-seed]", String(this.randomSeed ?? 0));
  }

  async loadChart() {
    const status = this.querySelector("[data-gekisou-load-status]");
    const summary = this.chartByKey.get(`${this.trackId}:${this.difficulty}`);
    this.chart = null;
    if (!summary) {
      if (status) status.textContent = document.documentElement.lang === "en"
        ? "No chart is available for this selection in the current server data."
        : "当前服务器资料中没有可用于此选择的谱面。";
      this.render();
      return;
    }
    if (status) status.textContent = "正在读取谱面事件…";
    const requestKey = `${summary.id}:${Date.now()}`;
    this.activeRequestKey = requestKey;
    try {
      const response = await fetch(summary.analysisDataUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const projection = await response.json();
      if (this.activeRequestKey !== requestKey) return;
      this.chart = { ...summary, ...projection };
      if (status) status.textContent = `已读取 ${this.chart.statistics?.judgementCount ?? 0} 个判定事件。`;
    } catch (error) {
      if (this.activeRequestKey !== requestKey) return;
      if (status) status.textContent = `谱面读取失败：${error.message}`;
    }
    this.render();
  }

  focusedParticipant() {
    return this.participants.find((entry) => entry.id === this.focusedParticipantId) ?? null;
  }

  buildScenario() {
    if (!this.chart) return null;
    const sourceTrack = this.trackById.get(this.trackId);
    const track = sourceTrack
      ? { ...sourceTrack, gekisouMissions: sourceTrack.missions }
      : null;
    return createGekisouScenario({
      sourceReleaseId: this.data.sourceReleaseId,
      track,
      chart: this.chart,
      participants: this.participants,
      focusedParticipantId: this.focusedParticipantId,
      mode: this.mode,
      randomnessPlan: {
        mode: "fixed",
        seed: this.randomSeed,
        outcomes: this.luckOutcomes
      },
      counterfactualOverrides: this.overrides
    });
  }

  renderParticipants() {
    const tabs = this.querySelector("[data-gekisou-participants]");
    if (!tabs) return;
    tabs.replaceChildren();
    this.participants.forEach((participant, index) => {
      const button = element("button", "gekisou-participant-tab");
      button.type = "button";
      button.dataset.participantId = participant.id;
      button.classList.toggle("is-focused", participant.id === this.focusedParticipantId);
      button.style.setProperty("--participant-color", COLORS[index]);
      button.setAttribute("aria-selected", String(participant.id === this.focusedParticipantId));
      const memberCount = participant.teamDraft.slots.filter((slot) => slot.memberCardId).length;
      const supportCount = participant.teamDraft.slots.filter((slot) => slot.supportCardId).length;
      button.append(
        element("strong", "", participant.label),
        element("span", "", `${memberCount}/5 成员 · ${supportCount}/5 留影`)
      );
      button.addEventListener("click", () => {
        this.focusedParticipantId = participant.id;
        this.render();
      });
      tabs.append(button);
    });
  }

  renderFocusedParticipant() {
    const participant = this.focusedParticipant();
    if (!participant) return;
    const label = this.querySelector("[data-gekisou-participant-label]");
    if (label) label.value = participant.label;
    const preset = this.querySelector("[data-gekisou-performance-preset]");
    if (preset) preset.value = participant.performancePlan.preset;
    const json = this.querySelector("[data-gekisou-team-json]");
    if (json && document.activeElement !== json) {
      json.value = serializeTeamDraftJson(participant.teamDraft);
    }
    const link = this.querySelector("[data-gekisou-team-link]");
    if (link instanceof HTMLAnchorElement) {
      link.href = toolRoute(`/tools/deck-builder/${serializeTeamDraftSearch(participant.teamDraft)}`, window.location.pathname);
    }
    const status = this.querySelector("[data-gekisou-team-status]");
    if (status) {
      const issues = validateTeamDraft(participant.teamDraft, this.known);
      status.textContent = issues.length === 0
        ? "TeamDraft 结构与当前 Release 一致。"
        : issues.map((entry) => entry.message).join("；");
      status.dataset.status = issues.length === 0 ? "accepted" : "rejected";
    }
    this.renderTeamSlots(participant);
    this.renderPerformanceInputs(participant);
    this.renderLuckInputs(participant);
    this.renderSkillBranches(participant);
  }

  cardOption(card, selectedId) {
    const option = element("option", "", `${card.label} · ${card.id}`);
    option.value = card.id;
    option.selected = card.id === selectedId;
    return option;
  }

  renderTeamSlots(participant) {
    const container = this.querySelector("[data-gekisou-team-slots]");
    if (!container) return;
    container.replaceChildren();
    participant.teamDraft.slots.forEach((slot, index) => {
      const row = element("div", "gekisou-team-slot");
      row.append(element("strong", "", String(index + 1).padStart(2, "0")));
      const member = element("select", "");
      member.setAttribute("aria-label", `槽位 ${index + 1} 成员卡`);
      const emptyMember = element("option", "", "未选择成员卡");
      emptyMember.value = "";
      member.append(emptyMember, ...this.data.memberCards.map((card) =>
        this.cardOption(card, slot.memberCardId)
      ));
      member.value = slot.memberCardId ?? "";
      member.addEventListener("change", () => {
        slot.memberCardId = member.value || null;
        this.render();
      });
      const support = element("select", "");
      support.setAttribute("aria-label", `槽位 ${index + 1} 留影`);
      const emptySupport = element("option", "", "未选择留影");
      emptySupport.value = "";
      support.append(emptySupport, ...this.data.supportCards.map((card) =>
        this.cardOption(card, slot.supportCardId)
      ));
      support.value = slot.supportCardId ?? "";
      support.addEventListener("change", () => {
        slot.supportCardId = support.value || null;
        this.render();
      });
      row.append(member, support);
      container.append(row);
    });
  }

  renderPerformanceInputs(participant) {
    const segmentContainer = this.querySelector("[data-gekisou-segment-inputs]");
    if (segmentContainer) {
      segmentContainer.replaceChildren();
      const missions = this.trackById.get(this.trackId)?.missions ?? [];
      (this.chart?.feverRanges ?? []).slice(0, 3).forEach((range, index) => {
        const segmentIndex = index + 1;
        const current = participant.performancePlan.segmentOverrides.find(
          (entry) => Number(entry.segmentIndex) === segmentIndex
        );
        const row = element("div", "gekisou-segment-input-row");
        row.append(element(
          "strong",
          "",
          `${segmentIndex} · ${missions[index]?.label ?? "UNKNOWN"} · ${range.start.toFixed(2)}–${range.end.toFixed(2)}s`
        ));
        const judgement = element("select", "");
        judgement.setAttribute("aria-label", `激奏段 ${segmentIndex} 输入判定`);
        const inherit = element("option", "", "继承预设");
        inherit.value = "";
        judgement.append(inherit, ...JUDGEMENT_LABELS.map((value) => {
          const option = element("option", "", value.toUpperCase());
          option.value = value;
          return option;
        }));
        judgement.value = current?.judgement ?? "";
        const comboLabel = element("label", "gekisou-check");
        const comboBreak = element("input", "");
        comboBreak.type = "checkbox";
        comboBreak.checked = current?.comboBreak === true;
        comboBreak.disabled = !current;
        comboLabel.append(comboBreak, element("span", "", "破连"));
        judgement.addEventListener("change", () => {
          participant.performancePlan.segmentOverrides = participant.performancePlan.segmentOverrides
            .filter((entry) => Number(entry.segmentIndex) !== segmentIndex);
          if (judgement.value) {
            participant.performancePlan.segmentOverrides.push({
              id: `segment-${segmentIndex}`,
              segmentIndex,
              judgement: judgement.value,
              comboBreak: comboBreak.checked
            });
          }
          this.render();
        });
        comboBreak.addEventListener("change", () => {
          const target = participant.performancePlan.segmentOverrides.find(
            (entry) => Number(entry.segmentIndex) === segmentIndex
          );
          if (target) target.comboBreak = comboBreak.checked;
          this.render();
        });
        row.append(judgement, comboLabel);
        segmentContainer.append(row);
      });
    }

    const noteIndex = this.querySelector("[data-gekisou-note-index]");
    if (noteIndex) noteIndex.max = String(this.chart?.comboEvents?.length ?? 1);
    const list = this.querySelector("[data-gekisou-note-overrides]");
    if (!list) return;
    list.replaceChildren();
    participant.performancePlan.noteOverrides.forEach((override) => {
      const judgement = this.chart?.comboEvents?.find((entry) => entry.markerId === override.markerId);
      const row = element("div", "gekisou-override-row");
      row.append(element(
        "span",
        "",
        `#${judgement?.combo ?? "?"} · ${judgement?.time?.toFixed(3) ?? "?"}s · ${String(override.judgement).toUpperCase()}${override.comboBreak ? " · 破连" : ""}`
      ));
      const remove = element("button", "", "删除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        participant.performancePlan.noteOverrides = participant.performancePlan.noteOverrides
          .filter((entry) => entry.markerId !== override.markerId);
        this.render();
      });
      row.append(remove);
      list.append(row);
    });
  }

  addNoteOverride() {
    const participant = this.focusedParticipant();
    if (!participant || !this.chart) return;
    const index = Number(this.querySelector("[data-gekisou-note-index]")?.value) - 1;
    const judgementEvent = this.chart.comboEvents?.[index];
    if (!judgementEvent) return;
    const judgement = this.querySelector("[data-gekisou-note-judgement]")?.value ?? "hit";
    const comboBreak = this.querySelector("[data-gekisou-note-break]")?.checked === true;
    participant.performancePlan.noteOverrides = participant.performancePlan.noteOverrides
      .filter((entry) => entry.markerId !== judgementEvent.markerId);
    participant.performancePlan.noteOverrides.push({
      id: `note-${judgementEvent.markerId}`,
      markerId: judgementEvent.markerId,
      judgement,
      comboBreak
    });
    this.render();
  }

  renderLuckInputs(participant) {
    const section = this.querySelector("[data-gekisou-luck-section]");
    const container = this.querySelector("[data-gekisou-luck-inputs]");
    if (!section || !container) return;
    const missions = this.trackById.get(this.trackId)?.missions ?? [];
    const luckMissions = missions.filter((mission) => mission.type === "luck");
    section.hidden = luckMissions.length === 0;
    container.replaceChildren();
    luckMissions.forEach((mission) => {
      const label = element("label", "gekisou-luck-input");
      label.append(element("span", "", `激奏 ${mission.index} · 固定整数输入`));
      const input = element("input", "");
      input.type = "number";
      input.step = "1";
      input.placeholder = "未指定";
      const existing = this.luckOutcomes.find((entry) =>
        entry.participantId === participant.id && Number(entry.segmentIndex) === mission.index
      );
      input.value = existing ? String(existing.value) : "";
      input.addEventListener("change", () => {
        this.luckOutcomes = this.luckOutcomes.filter((entry) =>
          !(entry.participantId === participant.id && Number(entry.segmentIndex) === mission.index)
        );
        if (input.value !== "") {
          this.luckOutcomes.push({
            id: `luck-${participant.id}-${mission.index}`,
            participantId: participant.id,
            segmentIndex: mission.index,
            value: Number(input.value)
          });
        }
        this.render();
      });
      label.append(input);
      container.append(label);
    });
  }

  selectedSkillOptions(participant) {
    const options = [];
    participant.teamDraft.slots.forEach((slot) => {
      for (const cardId of [slot.memberCardId, slot.supportCardId].filter(Boolean)) {
        const card = this.memberCardById.get(cardId) ?? this.supportCardById.get(cardId);
        for (const skillId of card?.skillIds ?? []) {
          const skill = this.skillById.get(skillId);
          options.push({ cardId, skillId, label: `${card.label} → ${skill?.name ?? skillId}` });
        }
      }
    });
    if (this.requestedSkillId && !options.some((entry) => entry.skillId === this.requestedSkillId)) {
      const skill = this.skillById.get(this.requestedSkillId);
      options.unshift({
        cardId: null,
        skillId: this.requestedSkillId,
        label: `技能档案 → ${skill?.name ?? this.requestedSkillId}`
      });
    }
    return options;
  }

  renderSkillBranches(participant) {
    const source = this.querySelector("[data-gekisou-skill-source]");
    if (source) {
      const selected = source.value;
      const options = this.selectedSkillOptions(participant);
      source.replaceChildren();
      if (options.length === 0) {
        const empty = element("option", "", "请先选择带激奏技能的卡牌");
        empty.value = "";
        source.append(empty);
      } else {
        source.append(...options.map((entry) => {
          const option = element("option", "", entry.label);
          option.value = `${entry.cardId ?? ""}|${entry.skillId}`;
          return option;
        }));
        source.value = options.some((entry) => `${entry.cardId ?? ""}|${entry.skillId}` === selected)
          ? selected
          : source.options[0]?.value ?? "";
      }
    }
    const marker = this.querySelector("[data-gekisou-skill-marker]");
    if (marker) {
      marker.replaceChildren(...(this.chart?.skillTimings ?? []).map((time, index) => {
        const option = element("option", "", `技能点 ${index + 1} · ${time.toFixed(3)}s`);
        option.value = String(index + 1);
        return option;
      }));
    }
    const list = this.querySelector("[data-gekisou-skills]");
    if (!list) return;
    list.replaceChildren();
    participant.skillBranches.forEach((branch) => {
      const skill = this.skillById.get(branch.skillId);
      const row = element("div", "gekisou-override-row");
      row.append(element(
        "span",
        "",
        `${skill?.name ?? branch.skillId} · 技能点 ${branch.markerIndex} · ${branch.durationSeconds}s · ${branch.experimentalScoreDelta >= 0 ? "+" : ""}${branch.experimentalScoreDelta}`
      ));
      const remove = element("button", "", "删除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        participant.skillBranches = participant.skillBranches.filter((entry) => entry.id !== branch.id);
        this.render();
      });
      row.append(remove);
      list.append(row);
    });
  }

  addSkillBranch() {
    if (this.mode !== "experiment") return;
    const participant = this.focusedParticipant();
    const rawSource = this.querySelector("[data-gekisou-skill-source]")?.value ?? "";
    const [sourceCardId, skillId] = rawSource.split("|");
    if (!participant || !skillId) return;
    let sequence = 1;
    while (participant.skillBranches.some((entry) =>
      entry.id === `skill-branch-${participant.id}-${sequence}`
    )) sequence += 1;
    const branchId = `skill-branch-${participant.id}-${sequence}`;
    participant.skillBranches.push({
      id: branchId,
      skillId,
      sourceCardId: sourceCardId || null,
      markerIndex: Number(this.querySelector("[data-gekisou-skill-marker]")?.value),
      durationSeconds: Number(this.querySelector("[data-gekisou-skill-duration]")?.value),
      experimentalScoreDelta: Number(this.querySelector("[data-gekisou-skill-score]")?.value),
      note: this.querySelector("[data-gekisou-skill-note]")?.value.trim() || null
    });
    this.render();
  }

  applyTeamDraft() {
    const json = this.querySelector("[data-gekisou-team-json]");
    const status = this.querySelector("[data-gekisou-team-status]");
    try {
      const draft = parseScopedTeamDraftJson(json?.value || "{}");
      const issues = validateTeamDraft(draft, this.known);
      if (issues.length > 0) throw new Error(issues.map((entry) => entry.message).join("；"));
      const participant = this.focusedParticipant();
      if (participant) participant.teamDraft = draft;
      this.render();
    } catch (error) {
      if (status) {
        status.textContent = `卡组未应用：${error.message}`;
        status.dataset.status = "rejected";
      }
    }
  }

  addOverride() {
    if (this.mode !== "experiment") return;
    const time = Number(this.querySelector("[data-gekisou-override-time]")?.value);
    const participantId = this.querySelector("[data-gekisou-override-participant]")?.value;
    const amount = Number(this.querySelector("[data-gekisou-override-amount]")?.value);
    const ownerKind = this.querySelector("[data-gekisou-override-owner-kind]")?.value || "manual";
    const ownerId = this.querySelector("[data-gekisou-override-owner]")?.value.trim() || "manual-effect";
    this.overrides.push({
      id: `override-${this.overrides.length + 1}`,
      kind: "score-delta",
      time,
      participantId,
      amount,
      owner: { kind: ownerKind, id: ownerId }
    });
    this.render();
  }

  renderOverrides() {
    const panel = this.querySelector("[data-gekisou-experiment]");
    if (panel) panel.hidden = this.mode !== "experiment";
    const participantSelect = this.querySelector("[data-gekisou-override-participant]");
    if (participantSelect) {
      const selected = participantSelect.value;
      participantSelect.replaceChildren(...this.participants.map((participant) => {
        const option = element("option", "", participant.label);
        option.value = participant.id;
        return option;
      }));
      participantSelect.value = this.participants.some((entry) => entry.id === selected)
        ? selected
        : this.focusedParticipantId;
    }
    const list = this.querySelector("[data-gekisou-overrides]");
    if (!list) return;
    list.replaceChildren();
    this.overrides.forEach((override) => {
      const row = element("div", "gekisou-override-row");
      const participant = this.participants.find((entry) => entry.id === override.participantId);
      row.append(element(
        "span",
        "",
        `${override.time}s · ${participant?.label ?? override.participantId} · ${override.amount >= 0 ? "+" : ""}${override.amount}`
      ));
      const remove = element("button", "", "删除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        this.overrides = this.overrides.filter((entry) => entry.id !== override.id);
        this.render();
      });
      row.append(remove);
      list.append(row);
    });
  }

  renderMissions(scenario) {
    const container = this.querySelector("[data-gekisou-missions]");
    if (!container) return;
    container.replaceChildren(...scenario.music.ranges.map((range) => {
      const card = element("article", `gekisou-mission gekisou-mission--${range.mission.type}`);
      card.append(
        element("span", "", `激奏 ${range.index}`),
        element("strong", "", range.mission.label),
        element("small", "", `${range.start.toFixed(3)}s – ${range.end.toFixed(3)}s`)
      );
      return card;
    }));
  }

  renderTimeline(scenario, result) {
    const svg = this.querySelector("[data-gekisou-timeline]");
    if (!svg) return;
    svg.replaceChildren();
    const width = 900;
    const height = 280;
    const left = 48;
    const right = 16;
    const top = 18;
    const bottom = 34;
    const duration = Math.max(1, scenario.music.duration);
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const x = (time) => left + (Math.max(0, Math.min(duration, time)) / duration) * plotWidth;
    const maxScore = Math.max(1, ...result.participants.map((entry) => entry.score ?? 0));
    const y = (score) => top + plotHeight - (score / maxScore) * plotHeight;

    scenario.music.ranges.forEach((range, index) => {
      svg.append(svgElement("rect", {
        x: x(range.start),
        y: top,
        width: Math.max(1, x(range.end) - x(range.start)),
        height: plotHeight,
        fill: COLORS[index],
        opacity: 0.12
      }));
      const label = svgElement("text", { x: x(range.start) + 6, y: top + 15, fill: "var(--theme-text)", "font-size": 11 });
      label.textContent = range.mission.label;
      svg.append(label);
    });
    for (let index = 0; index <= 4; index += 1) {
      const lineY = top + (plotHeight / 4) * index;
      svg.append(svgElement("line", { x1: left, y1: lineY, x2: width - right, y2: lineY, stroke: "var(--theme-border)" }));
    }

    scenario.participants.forEach((participant, index) => {
      let score = 0;
      const points = [[0, 0]];
      result.ledger
        .filter((entry) => entry.participantId === participant.id && entry.scoreDelta !== 0)
        .forEach((entry) => {
          score += entry.scoreDelta;
          points.push([entry.time, score]);
        });
      points.push([duration, score]);
      svg.append(svgElement("polyline", {
        points: points.map(([time, value]) => `${x(time)},${y(value)}`).join(" "),
        fill: "none",
        stroke: COLORS[index],
        "stroke-width": participant.id === this.focusedParticipantId ? 4 : 2,
        "stroke-linejoin": "round"
      }));
    });
    const startLabel = svgElement("text", { x: left, y: height - 10, fill: "var(--theme-muted)", "font-size": 11 });
    startLabel.textContent = "0:00";
    const endLabel = svgElement("text", { x: width - 48, y: height - 10, fill: "var(--theme-muted)", "font-size": 11 });
    endLabel.textContent = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}`;
    svg.append(startLabel, endLabel);
  }

  renderResult(scenario, result) {
    this.currentScenario = scenario;
    this.currentResult = result;
    const hash = this.querySelector("[data-gekisou-ledger-hash]");
    if (hash) hash.textContent = result.ledgerHash;
    const status = this.querySelector("[data-gekisou-result-status]");
    if (status) {
      status.textContent = result.status === "experimental"
        ? "自由实验：分数仅来自显式技能与手工反事实事件。"
        : result.status === "blocked"
          ? "规则结构已编译；正式分数因缺少客户端日志对账而关闭。"
          : result.issues.map((entry) => entry.message).join("；");
      status.dataset.status = result.status;
    }
    const results = this.querySelector("[data-gekisou-results]");
    if (results) {
      results.replaceChildren(...result.participants.map((participant, index) => {
        const row = element("article", "gekisou-participant-result");
        row.style.setProperty("--participant-color", COLORS[index]);
        row.append(
          element("strong", "", participant.label),
          element("span", "", participant.score === null ? "正式分数关闭" : participant.score.toLocaleString()),
          element("small", "", participant.finalRank === null ? "—" : `第 ${participant.finalRank} 名`),
          element(
            "small",
            "",
            `${participant.performance.totalJudgements} 判定 · 最大输入连击 ${participant.performance.maxCombo} · ${participant.performance.comboBreakCount} 次破连`
          )
        );
        return row;
      }));
    }
    const contributions = this.querySelector("[data-gekisou-contributions]");
    if (contributions) {
      contributions.replaceChildren(...result.participants.map((participant, index) => {
        const card = element("article", "gekisou-contribution-card");
        card.style.setProperty("--participant-color", COLORS[index]);
        card.append(element("strong", "", participant.label));
        if (result.status !== "experimental") {
          card.append(element("p", "", "正式卡牌与技能分数归因关闭"));
        } else if (participant.contributions.length === 0) {
          card.append(element("p", "", "暂无反事实贡献输入"));
        } else {
          const list = element("ul", "");
          participant.contributions.forEach((contribution) => {
            const item = element("li", "");
            item.append(
              element("span", "", `${contribution.owner.kind}:${contribution.owner.id}`),
              element("strong", "", contribution.amount.toLocaleString())
            );
            list.append(item);
          });
          card.append(list);
        }
        return card;
      }));
    }
    const segments = this.querySelector("[data-gekisou-segments]");
    if (segments) {
      segments.replaceChildren(...result.segments.map((segment) => {
        const card = element("article", "gekisou-segment-result");
        const ranking = segment.ranking.length === 0
          ? "阶段排名等待正式规则或实验事件"
          : segment.ranking
              .map((entry) => `${entry.rank}. ${this.participants.find((p) => p.id === entry.participantId)?.label} (${entry.score})`)
              .join(" · ");
        const performance = segment.performance
          .map((entry) => {
            const label = this.participants.find((participant) => participant.id === entry.participantId)?.label;
            return `${label}: Max ${entry.maxCombo}${entry.comboBreakCount ? ` / 破连 ${entry.comboBreakCount}` : ""}`;
          })
          .join(" · ");
        const luck = segment.luckInputs.length > 0
          ? `LUCK 输入：${segment.luckInputs.map((entry) => {
              const label = this.participants.find((participant) => participant.id === entry.participantId)?.label;
              return `${label}=${entry.value}`;
            }).join(" · ")}`
          : null;
        card.append(
          element("strong", "", `${segment.index} · ${segment.mission.label}`),
          element("p", "", ranking),
          element("small", "", performance)
        );
        if (luck) card.append(element("small", "", luck));
        return card;
      }));
    }
    const ledger = this.querySelector("[data-gekisou-ledger]");
    if (ledger) {
      const performanceCount = result.ledger.filter((entry) => entry.kind === "performance-judgement").length;
      const visibleEntries = result.ledger.filter((entry) => entry.kind !== "performance-judgement");
      const summary = element("li", "");
      summary.dataset.evidence = "user-input";
      summary.append(
        element("strong", "", `${performanceCount} 个演奏输入事件已编译`),
        element("span", "", "基础逐判定事件折叠显示；例外与汇总见参与者和激奏段。")
      );
      ledger.replaceChildren(summary, ...visibleEntries.map((entry) => {
        const item = element("li", "");
        const title = entry.kind === "counterfactual-score-delta" || entry.kind === "experimental-skill-score"
          ? `${entry.time.toFixed(3)}s · ${entry.participantId} · ${entry.scoreDelta >= 0 ? "+" : ""}${entry.scoreDelta}`
          : entry.kind === "luck-outcome"
            ? `${entry.time.toFixed(3)}s · ${entry.participantId} · LUCK=${entry.value}`
          : `${entry.time.toFixed(3)}s · ${entry.kind}`;
        item.append(
          element("strong", "", title),
          element("span", "", entry.mission?.label ?? entry.evidenceStatus)
        );
        item.dataset.evidence = entry.evidenceStatus;
        return item;
      }));
    }
    this.renderTimeline(scenario, result);
  }

  saveComparison() {
    if (!this.currentScenario || !this.currentResult) return;
    const input = this.querySelector("[data-gekisou-comparison-label]");
    const label = input?.value.trim()
      || `${this.currentScenario.music.title} · ${this.currentScenario.music.difficulty.toUpperCase()}`;
    const snapshot = {
      id: `comparison-${this.currentScenario.scenarioHash}`,
      label,
      scenarioHash: this.currentScenario.scenarioHash,
      ledgerHash: this.currentResult.ledgerHash,
      trackId: this.currentScenario.music.trackId,
      title: this.currentScenario.music.title,
      difficulty: this.currentScenario.music.difficulty,
      mode: this.currentScenario.mode,
      participants: this.currentResult.participants.map((participant) => ({
        id: participant.id,
        label: participant.label,
        score: participant.score,
        maxCombo: participant.performance.maxCombo,
        comboBreakCount: participant.performance.comboBreakCount
      }))
    };
    this.comparisons = [
      snapshot,
      ...this.comparisons.filter((entry) => entry.id !== snapshot.id)
    ].slice(0, 12);
    if (input) input.value = "";
    this.renderComparisons();
    this.persist(this.currentScenario);
  }

  renderComparisons() {
    const container = this.querySelector("[data-gekisou-comparisons]");
    if (!container) return;
    container.replaceChildren();
    if (this.comparisons.length === 0) {
      container.append(element("p", "gekisou-comparison-empty", "还没有保存比较快照。"));
      return;
    }
    this.comparisons.forEach((comparison) => {
      const card = element("article", "gekisou-comparison-card");
      card.append(
        element("small", "", `${comparison.mode === "experiment" ? "实验" : "规则"} · ${comparison.difficulty.toUpperCase()}`),
        element("strong", "", comparison.label),
        element("code", "", comparison.scenarioHash)
      );
      const list = element("ul", "");
      comparison.participants.forEach((participant) => {
        const item = element("li", "");
        item.append(
          element("span", "", participant.label),
          element(
            "strong",
            "",
            participant.score === null
              ? `Max ${participant.maxCombo} / 破连 ${participant.comboBreakCount}`
              : `${participant.score.toLocaleString()} · Max ${participant.maxCombo}`
          )
        );
        list.append(item);
      });
      const remove = element("button", "", "删除快照");
      remove.type = "button";
      remove.addEventListener("click", () => {
        this.comparisons = this.comparisons.filter((entry) => entry.id !== comparison.id);
        this.renderComparisons();
        if (this.currentScenario) this.persist(this.currentScenario);
      });
      card.append(list, remove);
      container.append(card);
    });
  }

  persist(scenario) {
    const payload = {
      sourceReleaseId: this.data.sourceReleaseId,
      ...currentServerContext(),
      trackId: this.trackId,
      difficulty: this.difficulty,
      mode: this.mode,
      participants: this.participants,
      focusedParticipantId: this.focusedParticipantId,
      overrides: this.overrides,
      randomSeed: this.randomSeed,
      luckOutcomes: this.luckOutcomes,
      comparisons: this.comparisons
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Local persistence is optional; the portable JSON remains available.
    }
    const params = new URLSearchParams();
    const server = currentServerContext().serverId;
    if (server) params.set('server', server);
    params.set("song", this.trackId);
    params.set("difficulty", this.difficulty);
    params.set("participants", String(this.participants.length));
    params.set("mode", this.mode);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
    const json = this.querySelector("[data-gekisou-scenario-json]");
    if (json && document.activeElement !== json) json.value = JSON.stringify({...scenario, ...currentServerContext()}, null, 2);
  }

  async copyScenario() {
    const json = this.querySelector("[data-gekisou-scenario-json]");
    const status = this.querySelector("[data-gekisou-copy-status]");
    try {
      await navigator.clipboard.writeText(json?.value ?? "");
      if (status) status.textContent = "场景 JSON 已复制。";
    } catch {
      if (status) status.textContent = "无法访问剪贴板，请手工复制。";
    }
  }

  async importScenario() {
    const json = this.querySelector("[data-gekisou-scenario-json]");
    const status = this.querySelector("[data-gekisou-copy-status]");
    try {
      const parsed = JSON.parse(json?.value || "{}");
      assertAccountServer(parsed.serverId);
      if (parsed.sourceReleaseId !== this.data.sourceReleaseId) {
        throw new Error("场景 Release 与当前站点不一致");
      }
      if (!this.trackById.has(parsed.music?.trackId)) throw new Error("场景歌曲不存在");
      this.trackId = parsed.music.trackId;
      this.difficulty = parsed.music.difficulty;
      this.mode = parsed.mode;
      this.participants = parsed.participants.map((entry, index) => this.normalizeParticipant(entry, index));
      this.focusedParticipantId = parsed.focusedParticipantId;
      this.overrides = parsed.counterfactualOverrides ?? [];
      this.randomSeed = parsed.randomnessPlan?.seed ?? 0;
      this.luckOutcomes = parsed.randomnessPlan?.outcomes ?? [];
      this.syncControls();
      await this.loadChart();
      if (status) status.textContent = "场景已导入并按当前谱面重新规范化。";
    } catch (error) {
      if (status) status.textContent = `导入失败：${error.message}`;
    }
  }

  render() {
    this.syncControls();
    this.renderParticipants();
    this.renderFocusedParticipant();
    this.renderOverrides();
    this.renderComparisons();
    if (!this.chart) return;
    const scenario = this.buildScenario();
    const result = runGekisouResearchSimulation(scenario);
    this.renderMissions(scenario);
    this.renderResult(scenario, result);
    this.persist(scenario);
  }
}

if (!customElements.get("gekisou-battle-lab")) {
  customElements.define("gekisou-battle-lab", GekisouBattleLab);
}
