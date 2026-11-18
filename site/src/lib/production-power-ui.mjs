import {planningUiText} from './team-planning-translations.mjs';
import {setupPresetPortfolio} from './preset-portfolio-ui.mjs';
import {setupInventoryOptimizer} from './inventory-optimizer-ui.ts';

/** Own planning lifecycles; card and account editing belong to the shared workspace. */
export function setupProductionPower(workbench) {
  const rules = workbench.data.formalRules;
  if (!rules || rules.sourceReleaseId !== workbench.data.sourceReleaseId) return null;
  const optimizer = setupInventoryOptimizer(workbench);
  const presets = setupPresetPortfolio(workbench);
  const cancel = () => { optimizer?.invalidate(); presets?.invalidate(); };
  return {
    disconnect: () => { optimizer?.destroy(); presets?.disconnect(); },
    changed() {
      cancel();
      workbench.querySelector("[data-pairing-results]")?.replaceChildren();
      const progress = workbench.querySelector("[data-pairing-progress]");
      if (progress) progress.textContent = planningUiText("输入已更新，可重新比较。",workbench.data.locale);
    }
  };
}
