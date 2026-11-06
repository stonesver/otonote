import {hasApTimingInstructions} from './ap-timing-presentation.mjs';

/** Read an already-scored order. This summary never simulates or sorts skills. */
export function skillOrderModel(result) {
  if (!result) return null;
  const playback = result.skillPlayback;
  const variant = playback?.variants?.find(v => v.kind === 'best') ?? playback?.variants?.[0];
  const order = result.bestOrder ?? variant?.order;
  if (!Array.isArray(order) || order.length !== 5 || new Set(order).size !== 5
    || order.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 4)) return null;
  const explicit = variant?.kind === 'explicit' || (result.performanceScenario?.profile === 'explicit' && result.orderCount === 1);
  const sampled = Boolean(result.randomSampling || playback?.randomSampling || result.randomSources?.player || result.randomSources?.game);
  const kind = result.apTimingPlan ? hasApTimingInstructions(result.apTimingPlan) ? 'timing' : 'on_time' : sampled ? 'sample' : explicit ? 'explicit' : result.scorePrecision === 'screen' ? 'screen' : 'best';
  return { kind, order: [...order] };
}

export function skillOrderSummary(data, draft, result) {
  const model = skillOrderModel(result);
  if (!model) return null;
  const en = document.documentElement.lang.startsWith('en');
  const say = (zh, english) => en ? english : zh;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const titles = { timing: say('微操方案技能顺序', 'Timing plan skill order'), on_time: say('正拍技能顺序', 'On-time skill order'), best: say('最高分顺序', 'Highest-score order'), sample: say('最高分样本顺序', 'Highest-sample order'),
    explicit: say('指定回放顺序', 'Entered replay order'), screen: say('粗筛最高分顺序', 'Screening order') };
  const root = node('section', null, 'activation-order');
  root.setAttribute('aria-label', titles[model.kind]);
  root.dataset.orderKind = model.kind;
  root.append(node('strong', titles[model.kind], 'activation-order-title'));
  const list = node('ol', null, 'activation-order-chain');
  for (const [position, slot] of model.order.entries()) {
    const id = draft?.slots?.[slot]?.memberCardId ?? result.skills?.[slot]?.memberCardId ?? result.skillPlayback?.skills?.[slot]?.memberCardId;
    const card = data.memberCards?.find(c => c.id === id);
    const name = card?.displayName ?? card?.shortLabel ?? say(`位置 ${slot + 1}`, `Slot ${slot + 1}`);
    const item = node('li'); item.dataset.slot = slot;
    item.title = say(`第 ${position + 1} 次 · ${name} · 位置 ${slot + 1}`, `Activation ${position + 1} · ${name} · Slot ${slot + 1}`);
    const art = node('span', null, 'activation-order-art');
    // Keep a meaningful fallback when artwork is missing or fails to load.
    const fallback = node('span', say(`位${slot + 1}`, `S${slot + 1}`)); fallback.setAttribute('aria-hidden', 'true'); art.append(fallback);
    if (card?.imageUrl) {
      const img = node('img'); img.src = card.imageUrl; img.alt = name; img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), { once: true }); art.append(img);
    } else art.setAttribute('aria-label', name);
    const index = node('b', String(position + 1).padStart(2, '0')); index.setAttribute('aria-hidden', 'true');
    item.setAttribute('aria-label', item.title); item.append(art, index); list.append(item);
  }
  root.append(list);
  return root;
}
