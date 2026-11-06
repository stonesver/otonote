<script lang="ts">
  import type {CalculationMode, CalculationObjective, OptimizerCandidate} from '../../lib/calculation/optimizer-types.ts';
  import {planningUiText} from '../../lib/team-planning-translations.mjs';
  import {hasApTimingInstructions} from '../../lib/ap-timing-presentation.mjs';

  let {result, mode, objective, live = false, index, scenarioLabel, trainingDescriptions, locale, createTeamView}: {
    result: OptimizerCandidate;
    mode?: CalculationMode;
    objective?: CalculationObjective;
    live?: boolean;
    index: number;
    scenarioLabel: string;
    trainingDescriptions: string[];
    locale: string;
    createTeamView: () => HTMLElement;
  } = $props();
  const ui = (text: string) => planningUiText(text, locale);
  const number = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString(undefined, {maximumFractionDigits: 2});
  const planning = $derived(result.planning);
  function teamView(node: HTMLElement) {
    const team = createTeamView();
    node.append(team);
    return {destroy: () => team.remove()};
  }
</script>

<header class="task-result-heading">
  <div>
    <div class="recommendation-heading">
      <span class="recommendation-label">{ui(result.direction?.label ?? (live ? '已找到的方案 · 计算中' : index ? `方案 ${index + 1}` : '推荐编成'))}</span>
      <span class="recommendation-mode">{ui(mode === 'gekisou' ? '激奏演出' : '普通自由演出')}</span>
    </div>
    <span class="recommendation-scenario">{ui(scenarioLabel)}</span>
  </div>
  <div class="recommendation-score">
    <strong>{result.value == null ? '—' : Math.round(result.value).toLocaleString()}</strong>
    <span>{ui(result.apTimingPlan ? (hasApTimingInstructions(result.apTimingPlan) ? '微操预计分' : '正拍预计分') : objective === 'formation_power' ? '综合力' : objective === 'expected_song_score' ? '参考平均分' : objective === 'minimum_song_score' ? '本次比较中的低分' : '本次比较中的高分')}</span>
    {#if result.delta != null && !planning?.missingActual}
      <em class={result.delta >= 0 ? 'is-positive' : 'is-negative'}>{ui(`${result.delta >= 0 ? '+' : ''}${number(result.delta)} 较当前养成方案`)}</em>
    {/if}
  </div>
</header>
<div style="display: contents" use:teamView></div>
{#if planning?.trainingChanges.length}
  <div class="recommendation-training">
    <strong>{ui(`这套队伍需要练好 ${planning.trainingChanges.length} 张卡`)}</strong>
    <ul>{#each trainingDescriptions as description}<li>{ui(description)}</li>{/each}</ul>
    {#if planning.plannedTeamCurrentValue != null}
      <dl class="recommendation-power">
        <div><dt>{ui('当前卡库方案')}</dt><dd>{number(planning.currentValue)}</dd></div>
        <div><dt>{ui('这套队伍按当前养成')}</dt><dd>{number(planning.plannedTeamCurrentValue)}</dd></div>
        <div><dt>{ui('这套队伍达到目标后')}</dt><dd>{number(planning.targetValue)}</dd></div>
      </dl>
    {/if}
    {#if planning.missingActual}
      <p>{ui(planning.plannedTeamCurrentValue != null ? '已按填写的养成比较这套队伍；持有情况未确认，不与当前卡库最佳队伍比较。' : '部分当前养成未记录，暂不计算比现在提高多少。')}</p>
    {/if}
    <p>{ui('材料消耗尚未核算；应用队伍不会修改实际卡库。')}</p>
  </div>
{:else if planning?.missingActual}
  <p class="recommendation-caption">{ui(planning.plannedTeamCurrentValue != null ? '已按填写的养成计算；持有情况未确认。' : '参考养成，非当前实力')}</p>
{/if}
