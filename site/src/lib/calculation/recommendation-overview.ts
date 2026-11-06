import {flushSync, mount, unmount} from 'svelte';
import type {ComponentProps} from 'svelte';
import RecommendationOverview from '../../components/calculation/RecommendationOverview.svelte';

// A workbench owns all its single-chart or playlist result roots.
const mounted = new WeakMap<Element, Map<Element, ReturnType<typeof mount>[]>>();
export function mountRecommendationOverview(workbench: Element, root: Element, target: Element,
  props: ComponentProps<typeof RecommendationOverview>): void {
  let roots = mounted.get(workbench);
  if (!roots) { roots = new Map(); mounted.set(workbench, roots); }
  const instances = roots.get(root) ?? [];
  roots.set(root, instances);
  flushSync(() => instances.push(mount(RecommendationOverview, {target, props})));
}
/** Unmount before legacy controllers replace DOM or disconnect the workbench. */
export function clearOptimizerResults(workbench: Element, target?: Element): void {
  const roots = mounted.get(workbench);
  if (roots) for (const [root, instances] of roots) {
    if (target && root !== target) continue;
    for (const instance of instances) void unmount(instance);
    roots.delete(root);
  }
  if (target) target.replaceChildren();
  else workbench.querySelector('[data-pairing-results]')?.replaceChildren();
}
