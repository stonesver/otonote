export const toolTags = ['personal-growth-workbench', 'team-draft-workbench',
  'scoring-research-workbench', 'live2d-workbench', 'song-ranking',
  'event-efficiency-tool', 'ap-grade-tool', 'gacha-history-tool'];
// Component display:grid/flex rules must not override the initial hidden state.
export const toolPendingStyle = '[data-tool-pending] { display: none !important; }';

export function revealTool(region) {
  region.inert = false;
  region.hidden = false;
  region.removeAttribute('aria-busy');
  region.removeAttribute('data-tool-pending');
}

/** Cold client rendering has the same first-paint boundary as prerendered HTML. */
export function stageClientTools(document, locale) {
  const regions = [...document.querySelectorAll(toolTags.join(','))];
  if (!regions.length) return () => {};
  const style = document.createElement('style');
  style.textContent = toolPendingStyle;
  document.head.append(style);
  const gates = regions.map(region => {
    region.inert = region.hidden = true;
    region.setAttribute('data-tool-pending', '');
    region.setAttribute('aria-busy', 'true');
    const gate = document.createElement('p');
    gate.setAttribute('data-tool-gate', '');
    gate.setAttribute('role', 'status');
    gate.textContent = locale === 'en' ? 'Preparing your tool…' : '正在准备工具，马上就好…';
    region.before(gate);
    return gate;
  });
  return () => {
    regions.forEach(revealTool);
    gates.forEach(gate => gate.remove());
  };
}

/** Prepare controls automatically; expensive actions still belong to their own buttons. */
export async function prepareTool({document, readJson, importModule, locale, onReady, onError = console.error}) {
  const region = document.querySelector('[data-tool-pending]');
  if (!region) return;
  const status = document.querySelector('[data-tool-status]');
  const gate = document.querySelector('[data-tool-gate]');
  const en = locale === 'en';
  try {
    const payloads = await Promise.all([...region.querySelectorAll('script[data-deferred-json]')].map(async node => ({
      node, value: await readJson(node.dataset.deferredJson, node.dataset.sha256)
    })));
    for (const {node, value} of payloads) node.textContent = JSON.stringify(value);
    // These modules are preloaded together by the HTML. Evaluate in order, only
    // after all JSON is present, so custom elements never see partial inputs.
    for (const script of document.querySelectorAll('script[data-deferred-module]')) {
      await importModule(script.dataset.deferredModule);
    }
    revealTool(region);
    gate?.remove();
    onReady();
  } catch (error) {
    onError(error);
    status.textContent = en ? 'Could not prepare this tool. Reload to try again.' : '工具准备失败，请重新加载后重试。';
    gate?.querySelector('[data-loading-interlude]')?.setAttribute('data-failed', '');
    const retry = document.querySelector('[data-tool-retry]');
    if (retry) retry.hidden = false;
    // Keep controls inert: ESM may already have partially initialized them.
    // A normal document reload gives retries a clean module/custom-element state.
  }
}
