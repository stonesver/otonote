import {eventTimestamp} from './event-time.mjs';

export function validateCostumes(value, context) {
  if (value == null) return {schemaVersion:1, ...context, status:'unavailable', costumes:[]};
  const invalid = () => { throw new Error('服装资料与当前版本不匹配 / Invalid costume content'); };
  if (value.schemaVersion !== 1 || value.contentReleaseId !== context.contentReleaseId
    || value.region !== context.region || value.locale !== context.locale
    || !['available','unavailable'].includes(value.status) || !Array.isArray(value.costumes)) invalid();
  const ids = new Set();
  for (const row of value.costumes) {
    if (!row || !Number.isInteger(row.masterId) || row.masterId <= 0
      || row.id !== `costume-group-${row.masterId}` || ids.has(row.id)
      || !/^character-\d+$/.test(row.characterId) || !/^band-\d+$/.test(row.bandId)
      || !Number.isInteger(row.characterMasterId) || row.characterId !== `character-${row.characterMasterId}`
      || typeof row.name !== 'string' || typeof row.isInitial !== 'boolean'
      || !(row.startAt === null || typeof row.startAt === 'string')
      || !(row.unlockMemberCardId === null || /^member-card-\d+$/.test(row.unlockMemberCardId))
      || !Array.isArray(row.models)) invalid();
    ids.add(row.id);
    if (row.poster != null && (typeof row.poster.url !== 'string'
      || !/^\/(?:costumes\/posters\/|content\/releases\/[a-f0-9]{24}\/public\/costumes\/posters\/)[0-9]+-[a-f0-9]{64}\.webp$/.test(row.poster.url)
      || !Number.isInteger(row.poster.width) || !Number.isInteger(row.poster.height)
      || row.poster.width <= 0 || row.poster.height <= 0)) invalid();
    if (row.icon !== null && (!row.icon || typeof row.icon.url !== 'string'
      || !/^\/(?:costumes\/|content\/releases\/[a-f0-9]{24}\/public\/costumes\/)/.test(row.icon.url)
      || row.icon.url.includes('..') || row.icon.width <= 0 || row.icon.height <= 0)) invalid();
    for (const model of row.models) {
      if (!Number.isInteger(model.masterId) || !Number.isInteger(model.typeCode) || typeof model.modelPath !== 'string'
        || !['available','unavailable'].includes(model.state)
        || (model.state === 'available' ? !/^[A-Za-z0-9_-]+$/.test(model.modelId) : model.modelId !== null)) invalid();
    }
  }
  if (value.status === 'unavailable' && value.costumes.length) invalid();
  return value;
}

export function costumeState(startAt, region, now = Date.now()) {
  const start = eventTimestamp(startAt, region);
  return start == null ? 'unknown' : now < start ? 'upcoming' : 'released';
}

export function costumePreviewPath(costume, model) {
  if (model.state !== 'available' || !model.modelId) return null;
  return `/tools/live2d/?${new URLSearchParams({character:String(costume.characterMasterId), costume:model.modelId})}`;
}

export function readCostumeFilters(search) {
  const params = new URLSearchParams(search);
  return {q:params.get('q') ?? '', band:params.get('band') ?? '', character:params.get('character') ?? ''};
}

export function costumeFilterSearch(search, filters) {
  const params = new URLSearchParams(search);
  for (const key of ['q','band','character']) {
    if (filters[key]) params.set(key, filters[key]); else params.delete(key);
  }
  return params.toString();
}

export function matchesCostume(row, filters) {
  const query = filters.q.trim().toLocaleLowerCase();
  return (!filters.band || row.bandId === filters.band)
    && (!filters.character || row.characterId === filters.character)
    && (!query || row.searchText.toLocaleLowerCase().includes(query));
}

export function costumeCopy(en) {
  return en ? {
    title:'Costumes', intro:'Find each member’s stage costumes and how to obtain them.',
    search:'Search costumes or characters', band:'Band', character:'Character', allBands:'All bands', allCharacters:'All characters',
    clear:'Clear filters', results:'costumes', initial:'Initial costume', unlock:'Unlockable costume',
    obtain:'Obtain', unknownUnlock:'Acquisition details unavailable', defaultUnlock:'Available from the start',
    starts:'Game schedule', upcoming:'Upcoming', released:'Release date reached', model:'Model', preview:'Preview',
    noModel:'Model preview not yet available', noIcon:'Image pending',
    pending:'Costume data has not been added to this release yet.', empty:'No wearable costumes in this release.',
    noMatch:'No costumes match these filters. Clear the filters to see all costumes.',
    timeNote:'Dates follow the site’s edition convention (Global: UTC+8; Japan: UTC+9). Game availability may change.',
  } : {
    title:'服装图鉴', intro:'收录成员的演出服装，查看获取条件与登场造型。',
    search:'搜索服装或角色名称', band:'乐队', character:'角色', allBands:'全部乐队', allCharacters:'全部角色',
    clear:'清除筛选', results:'套服装', initial:'初始服装', unlock:'条件获取',
    obtain:'获得', unknownUnlock:'获取方式待确认', defaultUnlock:'初始即可使用',
    starts:'游戏配置时间', upcoming:'待开放', released:'已到配置日期', model:'模型', preview:'预览',
    noModel:'模型预览待补充', noIcon:'图片待补充',
    pending:'当前版本服装资料待补充。', empty:'当前版本暂无可换装服装。',
    noMatch:'没有符合条件的服装，可清除筛选查看全部。',
    timeNote:'时间沿用本站区服约定：国际服 UTC+8、日服 UTC+9，实际开放情况以游戏为准。',
  };
}
