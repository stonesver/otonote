# 国际服公共维护状态

## 边界

用户已取消短期登录会话。本功能只缓存三服公共维护状态，不持有跨请求的玩家密码、令牌或登录状态。养成与抽卡继续每次查询独立认证。

状态来源是官方公开 `app.masterdata.MasterdataService/Version`，仅向 `tools/game_service_status.py` 中固定的三服主机发空请求，携带客户端版本与平台。没有账号探针，不使用 SDK 登录。公开发现成功不代表账号服务可用。

2026-10-18 实测三服均返回 `under maintenance`、`x-maintenance-total: 1` 及维护时间 02:00–06:00 UTC（北京时间 10:00–14:00）。预计结束时间不作为恢复证据。自由文本与原始异常不对外转发。

## 网关契约

`GET /api/growth-export/status/` 无需 nonce，仍校验 Host 和 Fetch-Site；响应 `Cache-Control: no-store`，不含 nonce 或玩家信息：

```json
{
  "schemaVersion": 1,
  "checkedAt": "2026-10-18T05:24:31+00:00",
  "validUntil": "2026-10-18T05:25:31+00:00",
  "servers": {
    "global-hmt": {
      "status": "maintenance",
      "source": "official_game_response",
      "maintenance": {
        "total": true,
        "startAt": "2026-10-18T02:00:00+00:00",
        "expectedEndAt": "2026-10-18T06:00:00+00:00",
        "emergency": false
      }
    }
  }
}
```

实际包含 `global-hmt`、`global-en`、`global-kr` 三行。状态语义：

| status | 含义 |
| --- | --- |
| `maintenance` | 官方明确返回总维护信号 |
| `no_maintenance_signal` | 公开 Version 请求成功；不证明账号登录成功 |
| `unknown` | 网络失败、超时、版本协商失败或无法识别的响应 |

`capabilities` 额外携带所选区服 `gameStatus`（缺省港澳台），`enabled` 继续只描述本站网关入口。账号读取已扩展到三服，详见 [三服读取说明](GLOBAL_ACCOUNT_READS.md)。维护时养成和抽卡返回 `503`、`error: game_maintenance` 与 `Retry-After: 60`，在发现和 SDK 登录前停止。若维护开始于预检查之后，原有只读 RPC 也会识别相同信号并返回维护错误。

## 开销与页面行为

- 每个网关进程共享 60 秒缓存，使用锁合并并发刷新。按需刷新，没有常驻定时任务；多进程/副本分别计数。
- 一次刷新三服并发，每服单次上限 2.5 秒；只在官方明确要求更新且推荐版本合法时重试一次，因此每轮最多六次公开调用。仅调整该公开请求版本，不修改账号链路版本。
- 浏览器每分钟请求本站公开状态，不携带凭据。访客增加仍会增加本站/CF HTTP 请求量，但不会逐人放大官方探测次数；未做生产容量压测。
- 国际版全站按所选区服显示横幅；未选区服时汇总受影响服务器。维护时停用账号读取，文件导入、配队和资料浏览继续可用。
- 检测失败或过期时不宣告恢复；已有横幅改为无法确认结束。只有新的有效公开响应不再给出维护信号才移除横幅。
- 恢复后不重放登录、不保存密码，由用户主动发起新查询。页面释放停止轮询，从浏览器往返缓存恢复时重新检查。

## 验证与发布边界

已完成三服真实公开状态探测、Python 网关及预览代理回归、前端维护/过期/恢复行为测试、独立 Web 程序构建、桌面与手机宽度真实组件浏览器检查。浏览器验收使用空图鉴夹具与真实维护状态，不代表完整内容库或真实账号验收。

Python 源码包构建依赖被 Git 排除的 `packaging/growth-tool/sdk.bhk.xml`；当前 worktree 未提供该私有文件，现有全量打包测试因此不能完成。新增维护模块已纳入源码分发清单和排行榜镜像复制范围，另用合成配置验证依赖完整性。

尚未推送、部署、重启或修改线上 CF。部署需同时更新网关程序和网站代码，并保留现有 `/api/growth-export/` 同源转发及缓存绕过设置；上线后另验 HTTPS 状态响应、维护拦截、CF 缓存行为及维护结束后的真实账号读取。


本次验证记录（2026-10-18）：

- 66 项 Python 回归通过，覆盖维护状态、网关、预览代理、登录读取、抽卡和排行榜采集。
- 30 项 Node 回归通过，覆盖状态文案、维护停用、过期响应、恢复、释放清理及相关原有功能。
- 独立 Web 构建成功：54 路由、59 交互脚本；本地预览 codeId `15ba8c967194380a26449389`。这是工作区构建，不是签名/已部署的正式候选。
- 使用合成 SDK 配置构造本地工具源码目录，在隔离 Python 导入路径下成功加载登录与维护模块；未使用真实 SDK 配置或玩家凭据。
- Playwright 检查实际 Astro 组件，桌面与 390px 手机宽度均显示真实维护状态。DOM 确认两项账号读取停用、文件输入可用；网络只有 capabilities/status，没有账号 POST，浏览器无错误。
- 本地截图保存在 `output/playwright/maintenance-desktop.png` 和 `output/playwright/maintenance-mobile.png`；完整本地工具私有配置打包、真实手机安装、生产部署与账号验收仍未完成。
