import {confirmManualGrowth,incompleteManualGrowth} from './manual-growth-input.mjs';
import {planningUiText} from './team-planning-translations.mjs';
import { createFormationCalculator } from "./scoring-rules/formation-power.mjs";
import { setupPresetPortfolio } from "./preset-portfolio-ui.mjs";
import { setupInventoryOptimizer } from "./inventory-optimizer-ui.mjs";
import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';

function cell(tag, value) {
  const node = document.createElement(tag);
  node.textContent = planningUiText(String(value),document.documentElement.lang);
  return node;
}

export function setupProductionPower(workbench) {
  const rules = workbench.data.formalRules;
  if (!rules || rules.sourceReleaseId !== workbench.data.sourceReleaseId) return null;
  const calculator = createFormationCalculator(rules);
  const controls = workbench.querySelector("[data-growth-controls]");
  const instrumentControls = workbench.querySelector("[data-instrument-controls]");
  const optimizer = setupInventoryOptimizer(workbench);
  const presets = setupPresetPortfolio(workbench);
  const cancel = () => { optimizer?.invalidate(); presets?.invalidate(); };

  function numberInput(label, value, min, max, set, optional = false, identity) {
    const wrapper = document.createElement("label");
    wrapper.append(cell("span", label));
    const input = document.createElement("input");
    input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1";
    input.value = value === undefined ? "" : String(value);
    input.placeholder = optional ? planningUiText("当前上限",workbench.data.locale) : String(min);
    if(identity){
      input.dataset.manualCard=identity.cardId;input.dataset.manualField=identity.field;
      // Preserve deliberately typed values before a slot switch rerenders the controls.
      input.addEventListener('input',()=>{
        if(!input.checkValidity())return;
        set(optional&&input.value===''?undefined:Number(input.value));cancel();
      });
    }
    input.addEventListener("change", () => {
      if (!input.checkValidity()) { input.reportValidity(); return; }
      if (!optional && input.value === "") { input.value = String(min); }
      set(optional && input.value === "" ? undefined : Number(input.value));
      if(identity){
        cancel();
        // Do not remove the confirmation button during the level input's blur event.
        if(['rank','awake'].includes(identity.field))workbench.commit();
      }else workbench.commit();
    });
    wrapper.append(input);
    return wrapper;
  }

  let confirmationNotice = "";
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
      controls?.append(numberInput(`${label}等级（上限 ${max}）`, input.level, 1, max, (v) => update("level", v), true, {cardId,field:"level"}));
      controls?.append(numberInput(`${label}突破阶数（1 = 未突破）`, input.rank ?? 1, 1, 5, (v) => update("rank", v), false, {cardId,field:"rank"}));
      if (kind === "Member") {
        controls?.append(numberInput("成员激奏技能等级", input.gekisouSkillLevel ?? 1, 1, 5, (v) => update("gekisouSkillLevel", v), false, {cardId,field:"gekisouSkillLevel"}));
        controls?.append(numberInput("成员演出技能等级", input.skillLevel ?? 1, 1, 5, (v) => update("skillLevel", v), false, {cardId,field:"skillLevel"}));
        controls?.append(numberInput("成员觉醒阶数（1 = 未觉醒）", input.awake ?? 1, 1, 5, (v) => update("awake", v), false, {cardId,field:"awake"}));
        controls?.append(numberInput("该角色评级", modifiers.characterRanks?.[row._characterID] ?? 1, 1, 50, (v) => {
          modifiers.characterRanks ??= {}; modifiers.characterRanks[row._characterID] = v;
        }));
        controls?.append(numberInput("该角色回忆固定值（每维）", modifiers.memoryPoints?.[row._characterID] ?? 0, 0, 100000, (v) => {
          modifiers.memoryPoints ??= {}; modifiers.memoryPoints[row._characterID] = v;
        }));
      } else controls?.append(cell("p", "留影的两项技能等级随突破阶数变化，按正式表自动计算。"));
    }
    const ids=[slot.memberCardId,slot.supportCardId].filter(Boolean);
    if(ids.length){
      const note=cell('p',incompleteManualGrowth(workbench.draft,ids).length
        ?'默认显示的阶数和技能等级还没有记为实际养成。填好实际等级，核对其他显示值后再确认。'
        :'当前槽位已有完整养成记录；修改显示值后可再次确认。');
      note.dataset.manualGrowthNotice='';controls?.append(note);
      const confirm=cell('button','确认当前槽位显示值为实际养成');confirm.type='button';confirm.dataset.confirmSlotGrowth='';
      confirm.addEventListener('click',()=>{
        try{
          const displayedGrowth={};
          for(const input of controls.querySelectorAll('[data-manual-card]')){
            if(!input.checkValidity())throw new Error('请检查当前槽位的等级与技能数值，再确认实际养成。');
            (displayedGrowth[input.dataset.manualCard]??={})[input.dataset.manualField]=input.value===''?undefined:Number(input.value);
          }
          workbench.draft=confirmManualGrowth(rules,workbench.draft,ids,{displayedGrowth});
          confirmationNotice='已确认当前槽位的实际养成，未修改持有状态或卡库。';workbench.commit();
        }catch(error){confirmationNotice=error.message;feedback.textContent=planningUiText(confirmationNotice,workbench.data.locale);feedback.focus();}
      });
      controls?.append(confirm,cell('p','仅用于这支队伍的养成比较，不会标记为已拥有，也不会写入实际卡库。'));
      const feedback=cell('p',confirmationNotice);feedback.dataset.manualGrowthStatus='';feedback.tabIndex=-1;feedback.setAttribute('role','status');controls?.append(feedback);
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

  return {
    settings() {
      try { settings(); }
      catch (error) { controls?.append(cell("p", `设置无效：${error.message}`)); }
    }, disconnect: () => { cancel(); presets?.disconnect(); },
    changed() {
      cancel();
      workbench.querySelector("[data-pairing-results]")?.replaceChildren();
      const progress = workbench.querySelector("[data-pairing-progress]");
      if (progress) progress.textContent = planningUiText("输入已更新，可重新比较。",workbench.data.locale);
    }
  };
}
