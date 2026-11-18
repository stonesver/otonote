const drafts = new Map();
const submitted = new Map();
const statuses = {pending:'待审核', scheduled:'等待公开时间', held:'已暂缓', published:'已发布', stale:'线上版本已变化'};
const kinds = {bands:'乐队', characters:'角色', memberCards:'成员卡', supportCards:'留影', musicTracks:'歌曲'};
const scopes = {'global-hmt':'港澳台', 'global-kr':'韩服', 'global-en':'EN', jp:'日服'};
const displayTime = stamp => new Date(stamp * 1000).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false});

export function renderPublicationReview({node, profile, enabled, el, api, status, refresh, confirm}) {
  const section = el('section', null, 'content-review');
  section.append(el('h4', '公开前审核'));
  const reviews = profile.health?.status === 'unavailable' ? null : profile.health?.publicationReviews;
  if (!reviews || reviews.status !== 'ready') {
    section.append(el('p', reviews?.status === 'disabled' ? '尚未启用发布审核。' : '审核状态暂不可用，请刷新或检查健康采样。', 'caption'));
    return section;
  }
  section.append(el('p', '按整批内容放行。正式公开时间须覆盖下列区服；解包配置日期不会自动批准。时间按北京时间填写，到期后由后台检查发布。', 'caption'));
  for (const region of ['global', 'jp']) {
    const row = reviews.regions?.[region];
    const card = el('section', null, 'delivery-region');
    card.append(el('h4', region === 'global' ? 'Global 国际服' : 'JP 日服'));
    if (!row) { card.append(el('p', '暂无待审批次。')); section.append(card); continue; }
    card.append(el('strong', statuses[row.status] || '状态未知'), el('p', row.contentReleaseId));
    card.append(el('p', `适用区服：${row.serverScopes.map(scope => scopes[scope] || scope).join('、')}`, 'caption'));
    if (row.publishAt !== null) card.append(el('p', `已确认公开时间：${displayTime(row.publishAt)}（北京时间）`));
    const summary = el('details'); summary.dataset.disclosure = `${node.id}:review:${region}`;
    summary.append(el('summary', `本批次内容 · ${row.summary.changedProjectionCount} 份资料变化`));
    for (const item of row.summary.entities) {
      summary.append(el('p', `${kinds[item.kind] || item.kind}：新增 ${item.added} 项${item.names.length ? ' · ' + item.names.join('、') : ''}${item.added > item.names.length ? ' 等' : ''}`));
    }
    summary.append(el('p', '新增名称仅为概览；既有条目的文本、媒体和其他资料变化见本批次变更文件。', 'caption'));
    const files = el('ul');
    for (const name of row.summary.changedProjections) files.append(el('li', name));
    summary.append(files, el('small', `批次 ${row.publication} · ${row.releaseId}`)); card.append(summary);
    if (row.status === 'stale') card.append(el('p', '请基于当前线上版本重新准备候选后审核。', 'caption'));
    if (['pending', 'scheduled', 'held'].includes(row.status)) {
      const identity = `${node.id}:${region}:${row.publication}:${row.revision}`;
      const label = el('label', '正式公开时间（北京时间）');
      const input = document.createElement('input'); input.type = 'datetime-local';
      input.value = drafts.get(identity) ?? (row.publishAt == null ? '' : new Date(row.publishAt * 1000 + 8 * 3600000).toISOString().slice(0, 16));
      input.addEventListener('input', () => drafts.set(identity, input.value)); label.append(input);
      const actions = el('div', null, 'toolbar'), message = el('p', '', 'caption'); message.setAttribute('role', 'status');
      const canWrite = enabled && node.canPublish;
      if (!canWrite) message.textContent = '当前账号或工作台尚未开放发布审核操作。';
      else if (submitted.has(identity)) message.textContent = submitted.get(identity);
      for (const [action, text] of [['publish','立即发布'], ['schedule','按此时间发布'], ['hold','暂缓']]) {
        const button = el('button', text); button.type = 'button';
        button.disabled = !canWrite || submitted.has(identity);
        button.addEventListener('click', async () => {
          const publishAt = action === 'schedule' ? Date.parse(input.value + '+08:00') / 1000 : null;
          if (action === 'schedule' && (!Number.isFinite(publishAt) || publishAt <= Date.now() / 1000)) {
            message.textContent = '请填写未来的、已确认的正式公开时间。'; return;
          }
          if (action !== 'hold' && !await confirm(action === 'publish'
            ? `确认本批次全部内容已在 ${row.serverScopes.map(scope => scopes[scope]).join('、')} 正式公开，并立即发布？`
            : `确认本批次全部内容在 ${row.serverScopes.map(scope => scopes[scope]).join('、')} 的正式公开时间为 ${displayTime(publishAt)}（北京时间），届时发布？`)) return;
          actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
          submitted.set(identity, '正在提交审核决定，请稍候。');
          message.textContent = submitted.get(identity);
          try {
            await api(`/api/nodes/${encodeURIComponent(node.id)}/publication-review`, {method:'POST',
              headers:{'Content-Type':'application/json','X-OurNotes-Request':'1'},
              body:JSON.stringify({region, publication:row.publication, revision:row.revision, action, publishAt})});
            submitted.set(identity, '审核决定已提交 Actions，尚不代表内容已发布。请等待运行完成及状态采样更新。');
            status(submitted.get(identity));
          } catch (error) {
            submitted.set(identity, `${error.message} 请先核对 Actions 和最新审核状态，再重新载入页面。`);
            status(submitted.get(identity), true);
          }
          message.textContent = submitted.get(identity);
          await refresh();
        });
        actions.append(button);
      }
      card.append(label, actions, message);
    }
    section.append(card);
  }
  return section;
}
