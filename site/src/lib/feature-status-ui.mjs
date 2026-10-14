import {artifact,snapshot,checkedJson,validatePointer,pageContext} from '../runtime/content.mjs';
import {featureStatus,snapshotFreshness} from './feature-status.mjs';
export async function installFeatureStatus(root) {
  const en=root.dataset.locale==='en', t=(zh,english)=>en?english:zh;
  const q=name=>root.querySelector(`[data-feature-${name}]`);
  const labels={available:t('可用','Available'),partial:t('部分支持','Partial'),unavailable:t('不可用','Unavailable'),estimated:t('参考估算，未实战核验','Reference estimate; gameplay unverified')};
  try {
    const [catalog,modes,rules,scoring,recognition,pinned]=await Promise.all([
      artifact('projection/catalog.json'),artifact('projection/game-modes.json'),
      artifact('supplemental/formal-scoring-rules.json',{optional:true}),artifact('supplemental/scoring-compatibility.json',{optional:true}),
      artifact('supplemental/card-recognition.json',{optional:true}),snapshot()]);
    const data=featureStatus({catalog,modes,rules,scoring,recognition});
    q('version').textContent=`${data.region.toUpperCase()} · ${data.clientVersion} (${data.clientVersionCode}) · ${data.generatedAt}`;
    q('content').textContent=`${data.sourceReleaseId} · ${t('资源版本','Resource version')}: ${pinned.releaseRecord?.resourceVersion??t('未记录','Not recorded')}`;
    q('catalog').textContent=`${labels[data.catalog.status]} · ${data.catalog.members} / ${data.catalog.supports}`;
    q('events').textContent=`${labels[data.events.status]} · ${data.events.count}`;
    q('calculator').textContent=`${labels[data.calculator.status]} · ${data.calculator.ruleSetVersion??t('规则版本未知','Unknown rule version')}`;
    q('screenshot').textContent=(data.screenshot.status==='available'?t('索引可用','Index available'):labels[data.screenshot.status])+(recognition&&data.screenshot.cards!=null ? ` · ${data.screenshot.cards}/${data.screenshot.totalCards} · ${t('缺失卡面','Missing artwork')} ${data.screenshot.missingAssets}` : ` · ${t('本版本索引未提供或不兼容','Index missing or incompatible for this release')}`);
    try {
      const latest=validatePointer(await checkedJson(pageContext().region==='jp'?'/content/jp/current.json':'/content/current.json'));
      const state=snapshotFreshness(pinned,latest);root.dataset.freshness=state;
      q('freshness').textContent=state==='current'?t('与最新公开版本一致（本次检查）','Matches the latest public release at this check'):t('本页为旧版本，请刷新后使用新内容；不会混用新旧索引。','This page uses an older release. Reload for current data. Index versions are never mixed.');
    } catch {root.dataset.freshness='unknown';q('freshness').textContent=t('暂时无法检查最新版本；下列状态仅针对本页快照。','Latest release could not be checked; statuses apply to this page snapshot.');}
  } catch {q('freshness').textContent=t('功能状态读取失败，请刷新重试；不能确认当前可用性。','Could not verify feature status. Reload to retry.');root.dataset.freshness='unknown';}
}
