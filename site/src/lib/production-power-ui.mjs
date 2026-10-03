import { createFormationCalculator } from "./scoring-rules/formation-power.mjs";
import { serializeTeamDraftSearch } from "./team-draft.mjs";
import { setupPresetPortfolio } from "./preset-portfolio-ui.mjs";
import { setupInventoryOptimizer } from "./inventory-optimizer-ui.mjs";
import { toolRoute } from "./tool-route.mjs";

import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';

const labels = {
  member: "成员", support: "留影", characterRank: "角色评级", characterTotalRank: "全角色评级",
  memory: "回忆加成", typeLink: "属性连携", leader: "队长技能", bandItems: "乐器 / 乐队道具",
  musicType: "歌曲属性", musicTag: "擅长歌曲", tgw: "T.G.W CARD"
};

function cell(tag, value) {
  const node = document.createElement(tag);
  node.textContent = String(value);
  return node;
}

export function setupProductionPower(workbench) {
  const rules = workbench.data.formalRules;
  if (!rules || rules.sourceReleaseId !== workbench.data.sourceReleaseId) return null;
  const calculator = createFormationCalculator(rules);
  const controls = workbench.querySelector("[data-growth-controls]");
  const breakdown = workbench.querySelector("[data-production-breakdown]");
  const message = workbench.querySelector("[data-production-status]");
  const instrumentControls = workbench.querySelector("[data-instrument-controls]");
  const optimizer = setupInventoryOptimizer(workbench);
  const presets = setupPresetPortfolio(workbench);
  const cancel = () => { optimizer?.invalidate(); presets?.invalidate(); };

  function numberInput(label, value, min, max, set, optional = false) {
    const wrapper = document.createElement("label");
    wrapper.append(cell("span", label));
    const input = document.createElement("input");
    input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1";
    input.value = value === undefined ? "" : String(value);
    input.placeholder = optional ? "当前上限" : String(min);
    input.addEventListener("change", () => {
      if (!input.checkValidity()) { input.reportValidity(); return; }
      if (!optional && input.value === "") { input.value = String(min); }
      set(optional && input.value === "" ? undefined : Number(input.value));
      workbench.commit();
    });
    wrapper.append(input);
    return wrapper;
  }

  function settings() {
    const modifiers = workbench.draft.modifiers;
    controls?.replaceChildren();
    const slot = workbench.draft.slots[workbench.activeSlot];
    for (const [kind, cardId] of [["Member", slot.memberCardId], ["Support", slot.supportCardId]]) {
      if (!cardId) continue;
      const label = kind === "Member" ? "成员" : "留影";
      let row;
      try { row = calculator.card(cardId, kind.toLowerCase()); }
      catch (error) { controls?.append(cell("p", error.message)); continue; }
      const input = modifiers.growth?.[cardId] ?? {};
      const update = (field, value) => {
        modifiers.growth ??= {};
        modifiers.growth[cardId] = { ...modifiers.growth[cardId], [field]: value };
        // A rank/awake change can lower the cap; let the level follow the new cap.
        if (["rank", "awake"].includes(field)) delete modifiers.growth[cardId].level;
      };
      const max = kind === "Member" ? rules.tables.MemberCardLevelLimit.find((r) =>
        r._rarity === row._rarity && r._awakeCount === (input.awake ?? 1))?._limitLevel
        : rules.tables.SupportCardRank.find((r) => r._group === row._supportCardRankGroup && r._rank === (input.rank ?? 1))?._limitLevel;
      controls?.append(numberInput(`${label}等级（上限 ${max}）`, input.level, 1, max, (v) => update("level", v), true));
      controls?.append(numberInput(`${label}突破阶数（1 = 未突破）`, input.rank ?? 1, 1, 5, (v) => update("rank", v)));
      if (kind === "Member") {
        controls?.append(numberInput("成员激奏技能等级", input.gekisouSkillLevel ?? 1, 1, 5, (v) => update("gekisouSkillLevel", v)));
        controls?.append(numberInput("成员演出技能等级", input.skillLevel ?? 1, 1, 5, (v) => update("skillLevel", v)));
        controls?.append(numberInput("成员觉醒阶数（1 = 未觉醒）", input.awake ?? 1, 1, 5, (v) => update("awake", v)));
        controls?.append(numberInput("该角色评级", modifiers.characterRanks?.[row._characterID] ?? 1, 1, 50, (v) => {
          modifiers.characterRanks ??= {}; modifiers.characterRanks[row._characterID] = v;
        }));
        controls?.append(numberInput("该角色回忆固定值（每维）", modifiers.memoryPoints?.[row._characterID] ?? 0, 0, 100000, (v) => {
          modifiers.memoryPoints ??= {}; modifiers.memoryPoints[row._characterID] = v;
        }));
      } else controls?.append(cell("p", "留影的两项技能等级随突破阶数变化，按正式表自动计算。"));
    }
    instrumentControls?.replaceChildren();
    for(const group of bandItemGroups(rules)){
      const name=workbench.data.bands?.find(b=>(b.masterId??b.id)===group.bandId)?.name??`乐队 ${group.bandId}`;
      if(group.supported){
        const total=modifiers.bandItemTotals?.[group.bandId]??group.items.reduce((n,i)=>n+(modifiers.bandItems?.[i.id]??0),0);
        instrumentControls?.append(numberInput(`${name} 道具总等级`,total,0,group.maxTotal,v=>{(modifiers.bandItemTotals??={})[group.bandId]=v;}));
      }else for(const item of group.items){
        const instrument=workbench.data.instruments?.find(i=>i.id===item.id);
        instrumentControls?.append(numberInput(instrument?.name??`${name} 道具 ${item.id}`,modifiers.bandItems?.[item.id]??0,0,item.maxLevel,v=>{(modifiers.bandItems??={})[item.id]=v;}));
      }
    }
    const ranks = workbench.querySelector("[data-character-rank-controls]");
    ranks?.replaceChildren();
    for (const character of workbench.data.characters ?? []) {
      ranks?.append(numberInput(character.name, modifiers.characterRanks?.[character.id] ?? 1, 1, 50, (v) => {
        modifiers.characterRanks ??= {}; modifiers.characterRanks[character.id] = v;
      }));
    }
  }

  workbench.querySelector("[data-reset-power-settings]")?.addEventListener("click", () => {
    workbench.draft.modifiers = {};
    workbench.parseIssues = [];
    workbench.commit();
  });

  return {
    settings() {
      try { settings(); }
      catch (error) { controls?.append(cell("p", `设置无效：${error.message}`)); }
    }, disconnect: () => { cancel(); presets?.disconnect(); },
    changed() {
      cancel();
      workbench.querySelector("[data-pairing-results]")?.replaceChildren();
      const progress = workbench.querySelector("[data-pairing-progress]");
      if (progress) progress.textContent = "输入已更新，可重新比较。";
    },
    render() {
      breakdown?.replaceChildren();
      try {
        if (workbench.parseIssues?.length) throw new Error("分享链接的加成设置无效，请重置成长与加成设置。");
        const result = calculator.calculate(workbench.draft, { sourceReleaseId: workbench.data.sourceReleaseId });
        for (const [name, value] of Object.entries(result.breakdown)) {
          const row = document.createElement("tr");
          row.append(cell("th", labels[name] ?? name), ...[value.performance, value.technic, value.visual, value.total].map((n) => cell("td", n.toLocaleString())));
          breakdown?.append(row);
        }
        message.textContent = (rules.verificationStatus === 'reference_compatible' ? '已按参考规则估算；' : '已按正式包代码计算；')
          + '第三槽为队长。当前数值为综合能力，歌曲分数还要经过谱面与演出技能计算。';
        const trace = workbench.querySelector("[data-power-trace]");
        if (trace) trace.textContent = JSON.stringify(result, null, 2);
        return result.total;
      } catch (error) {
        message.textContent = error.message;
        const trace = workbench.querySelector("[data-power-trace]");
        if (trace) trace.textContent = "无有效计算结果";
        return null;
      } finally {
        for (const anchor of workbench.querySelectorAll("[data-production-link]")) {
          anchor.href = toolRoute(`${anchor.dataset.productionLink}${serializeTeamDraftSearch(workbench.draft)}`, window.location.pathname);
        }
      }
    }
  };
}
