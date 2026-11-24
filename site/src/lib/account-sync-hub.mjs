import { accountCapabilitiesUrl, accountServer } from './account-servers.mjs';
import { maintenanceNotice } from './game-service-status.mjs';

export const GACHA_HANDOFF_KEY = 'ournotes:gacha-handoff:v1';
const GACHA_MEMORY_SYMBOL = Symbol.for('ournotes.gacha.session.v1');

export const SYNC_SERVICES = Object.freeze([
  {
    id: 'growth',
    zh: '卡库与养成档案',
    en: 'Cards & personal growth',
    hintZh: '成员卡、留影、乐器、角色评级与 TGW（预览确认后保存，全站共用）',
    hintEn: 'Members, snaps, instruments, character ranks, and TGW (preview before saving).',
  },
  {
    id: 'gacha',
    zh: '抽卡记录查询',
    en: 'Gacha draw history',
    hintZh: '本次官方返回记录（仅存页面会话内存，刷新或离开后清空）',
    hintEn: 'Draws returned by the game server (session memory only; cleared on leave).',
  },
  {
    id: 'arena',
    zh: '激奏舞台本人排名',
    en: 'Personal arena rank',
    hintZh: '仅查询当前选定的激奏舞台赛季与乐队排名',
    hintEn: 'Queries your rank for the currently selected arena season and band.',
  },
]);

const ERROR_MESSAGES = {
  credentials_rejected: '账号或密码校验未通过，请检查后重新登录。',
  account_not_found: '官方服务提示当前区服下不存在此账号角色。',
  verification_required: '需要额外验证，本次同步已停止。',
  rate_limited: '请求过于频繁，请稍后再试。',
};

const FATAL_REASONS = new Set(['credentials_rejected', 'account_not_found', 'verification_required', 'rate_limited']);

export function stageGachaHandoff(snapshot, serverId, storage = globalThis.sessionStorage) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  globalThis[GACHA_MEMORY_SYMBOL] = { snapshot, serverId };
  try {
    storage?.setItem(GACHA_HANDOFF_KEY, JSON.stringify({ snapshot, serverId }));
    return true;
  } catch {
    return false;
  }
}

export function consumeGachaHandoff(expectedServerId = null, storage = globalThis.sessionStorage) {
  let payload = globalThis[GACHA_MEMORY_SYMBOL] ?? null;
  delete globalThis[GACHA_MEMORY_SYMBOL];
  try {
    const raw = storage?.getItem(GACHA_HANDOFF_KEY);
    storage?.removeItem(GACHA_HANDOFF_KEY);
    if (!payload && raw) payload = JSON.parse(raw);
  } catch {
    try { storage?.removeItem(GACHA_HANDOFF_KEY); } catch {}
  }
  if (!payload || typeof payload !== 'object' || !payload.snapshot) return null;
  if (expectedServerId && payload.serverId && payload.serverId !== expectedServerId) return null;
  return payload.snapshot;
}

export function clearGachaHandoff(storage = globalThis.sessionStorage) {
  delete globalThis[GACHA_MEMORY_SYMBOL];
  try {
    storage?.removeItem(GACHA_HANDOFF_KEY);
  } catch {}
}

export function createAccountSyncClient({ fetcher = fetch, timeout = 150000 } = {}) {
  let nonce = null;
  let capabilities = null;
  let activeServerId = null;
  let maintenance = false;
  let checkAbort = null;
  let syncAbort = null;
  let busy = false;

  const getState = () => ({ nonce, capabilities, serverId: activeServerId, maintenance, busy });

  async function checkCapabilities(serverId) {
    if (busy) return { ok: false, reason: 'busy', message: '正在执行同步，请稍候。' };
    checkAbort?.abort();
    nonce = null;
    capabilities = null;
    activeServerId = serverId ?? null;
    maintenance = false;

    if (!accountServer(serverId)) {
      return {
        ok: false,
        reason: 'unsupported_server',
        message: '请先在顶部区服切换器中选择港澳台、EN 或韩服账号区服。',
      };
    }

    const controller = (checkAbort = new AbortController());
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(accountCapabilitiesUrl(serverId), {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, reason: 'unavailable', message: '登录服务暂不可用，请稍后重新检查。' };
      }
      const result = await response.json();
      if (
        result?.enabled !== true ||
        typeof result.nonce !== 'string' ||
        !result.nonce ||
        (result.serverId && result.serverId !== serverId)
      ) {
        return { ok: false, reason: 'unavailable', message: '登录服务返回配置不完整，请稍后重新检查。' };
      }
      if (controller.signal.aborted) {
        return { ok: false, reason: 'aborted', message: '连接检查已取消。' };
      }
      nonce = result.nonce;
      capabilities = result;
      activeServerId = serverId;
      maintenance = result.gameStatus?.status === 'maintenance';
      return {
        ok: true,
        serverId,
        nonce,
        capabilities: result,
        maintenance,
        message: maintenance
          ? maintenanceNotice(result.gameStatus)
          : '共用登录服务已连接 · 每次点击手动同步，不保存密码或令牌',
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.name === 'AbortError' ? 'timeout' : 'unavailable',
        message: error?.name === 'AbortError' ? '检查登录服务超时，请重试。' : '暂时无法连接登录服务，请稍后重试或使用本地 JSON 导入。',
      };
    } finally {
      clearTimeout(timer);
      if (checkAbort === controller) checkAbort = null;
    }
  }

  function applyGameStatus(observation) {
    maintenance = observation?.status === 'maintenance';
    if (capabilities) {
      capabilities = { ...capabilities, gameStatus: observation };
    }
    return {
      maintenance,
      message: maintenance
        ? maintenanceNotice(observation)
        : '共用登录服务已连接 · 每次点击手动同步，不保存密码或令牌',
    };
  }

  function abortSync() {
    syncAbort?.abort();
  }

  async function syncSelected({ serverId, account, password, services = [], arenaScope = null, onProgress = () => {} }) {
    let userAccount = typeof account === 'string' ? account.trim() : '';
    let userPassword = typeof password === 'string' ? password : '';
    account = '';
    password = '';

    const selected = [...new Set(services)].filter(id => ['growth', 'gacha', 'arena'].includes(id));
    if (busy) {
      userAccount = '';
      userPassword = '';
      throw Error('正在同步中，请等待当前请求完成。');
    }
    if (!accountServer(serverId) || serverId !== activeServerId) {
      userAccount = '';
      userPassword = '';
      throw Error('当前区服尚未完成登录服务检查，请先检查连接状态。');
    }
    if (!nonce || maintenance) {
      userAccount = '';
      userPassword = '';
      throw Error(maintenance ? '当前区服正在维护，暂不可在线同步。' : '登录连接已失效，请点击“重新检查”。');
    }
    if (!selected.length) {
      userAccount = '';
      userPassword = '';
      throw Error('请至少勾选一项要同步的功能。');
    }
    if (!userAccount || !userPassword) {
      userAccount = '';
      userPassword = '';
      throw Error('请输入 BHK 邮箱账号与密码。');
    }

    busy = true;
    const controller = (syncAbort = new AbortController());
    const results = {};
    const errors = {};
    let nonceExpired = false;
    let abortedReason = null;

    const endpoints = {
      growth: {
        url: '/api/growth-export/read/',
        maxBytes: 2_000_000,
        label: '卡库与养成档案',
        buildBody: () => JSON.stringify({ serverId, account: userAccount, password: userPassword }),
      },
      gacha: {
        url: '/api/growth-export/gacha-history/',
        maxBytes: 2_000_000,
        label: '抽卡记录',
        buildBody: () => JSON.stringify({ serverId, account: userAccount, password: userPassword }),
      },
      arena: {
        url: '/api/growth-export/arena-rank/',
        maxBytes: 16_384,
        label: '激奏舞台本人排名',
        buildBody: () =>
          JSON.stringify({
            serverId,
            seasonId: arenaScope?.seasonId,
            bandId: arenaScope?.bandId,
            account: userAccount,
            password: userPassword,
          }),
      },
    };

    try {
      for (let i = 0; i < selected.length; i++) {
        const serviceId = selected[i];
        const spec = endpoints[serviceId];
        if (serviceId === 'gacha' && capabilities && capabilities.gachaHistory !== true) {
          errors[serviceId] = '当前服务端未开放抽卡记录查询。';
          continue;
        }
        if (serviceId === 'arena' && (!capabilities?.arenaPersonal || !arenaScope?.seasonId || !arenaScope?.bandId)) {
          errors[serviceId] = '未指定激奏舞台赛季或乐队，已跳过个人排名查询。';
          continue;
        }

        onProgress({ serviceId, label: spec.label, index: i, total: selected.length, status: 'running' });
        const timer = setTimeout(() => controller.abort(), timeout);
        let body = '';
        try {
          body = spec.buildBody();
          const response = await fetcher(spec.url, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              'X-Growth-Nonce': nonce,
            },
            body,
            signal: controller.signal,
          });
          body = '';
          const declaredSize = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(declaredSize) && declaredSize > spec.maxBytes) {
            throw Object.assign(Error(`${spec.label}返回内容过大，未载入。`), { fatal: false });
          }
          const text = await response.text();
          if (text.length > spec.maxBytes) {
            throw Object.assign(Error(`${spec.label}返回内容过大，未载入。`), { fatal: false });
          }
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = {};
            if (response.status !== 403) {
              throw Object.assign(Error(`${spec.label}返回异常，请稍后重试。`), { fatal: false });
            }
          }

          if (parsed?.error === 'game_maintenance' || parsed?.gameStatus?.status === 'maintenance') {
            applyGameStatus(parsed.gameStatus ?? { status: 'maintenance' });
            throw Object.assign(Error(maintenanceNotice(parsed.gameStatus ?? { status: 'maintenance' })), {
              fatal: true,
              code: 'game_maintenance',
            });
          }
          if (parsed?.error === 'game_client_update_required') {
            throw Object.assign(Error('游戏要求新的客户端版本，本次同步已停止；请稍后重试。'), {
              fatal: true,
              code: 'game_client_update_required',
            });
          }
          if (!response.ok) {
            if (response.status === 403) {
              nonce = null;
              nonceExpired = true;
              throw Object.assign(Error('本次连接校验已过期，请点击“重新检查”后再同步。'), {
                fatal: true,
                code: 'expired',
              });
            }
            if (response.status === 429 || parsed?.reason === 'rate_limited') {
              throw Object.assign(Error(ERROR_MESSAGES.rate_limited), { fatal: true, code: 'rate_limited' });
            }
            if (FATAL_REASONS.has(parsed?.reason)) {
              throw Object.assign(Error(ERROR_MESSAGES[parsed.reason]), { fatal: true, code: parsed.reason });
            }
            const sdkCode =
              typeof parsed?.error === 'string' && /^sdk_service_-?\d+$/.test(parsed.error) ? `（${parsed.error}）` : '';
            throw Object.assign(Error(`${spec.label}读取未完成，请稍后重试。${sdkCode}`), { fatal: false });
          }

          results[serviceId] = parsed.snapshot;
          onProgress({ serviceId, label: spec.label, index: i, total: selected.length, status: 'done' });
        } catch (error) {
          body = '';
          const message =
            error?.name === 'AbortError' ? `${spec.label}读取超时或已取消。` : error?.message || `${spec.label}读取失败。`;
          errors[serviceId] = message;
          onProgress({ serviceId, label: spec.label, index: i, total: selected.length, status: 'error', message });
          if (error?.fatal || error?.name === 'AbortError') {
            abortedReason = error?.code ?? (error?.name === 'AbortError' ? 'aborted' : 'fatal');
            break;
          }
        } finally {
          body = '';
          clearTimeout(timer);
        }
      }
    } finally {
      userAccount = '';
      userPassword = '';
      busy = false;
      if (syncAbort === controller) syncAbort = null;
    }

    return {
      ok: Object.keys(errors).length === 0,
      results,
      errors,
      abortedReason,
      nonceExpired,
      maintenance,
    };
  }

  return {
    getState,
    checkCapabilities,
    applyGameStatus,
    syncSelected,
    abortSync,
  };
}
