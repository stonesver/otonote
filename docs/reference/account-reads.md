# 三服邮箱认证与账号读取

## 范围与限制

支持港澳台、EN、韩服的 BHK 邮箱密码认证、养成读取及抽卡查询。每次读取重新完成 SDK 和游戏认证，不缓存玩家密码、令牌或跨请求身份；App 暂不开发。Google 游戏授权未接通，不将本站 Google OAuth 当成游戏身份。

导入保留缺卡拒绝，不静默丢卡后覆盖原档案；未返回的养成保持未读取。游戏内人工对账及尚未接通的认证方式见[未结事项](../BACKLOG.md)。

## 区服与 API

| serverId | 官方名称 | 游戏服务器编号 | 记录展示时区 |
| --- | --- | --- | --- |
| `global-hmt` | TW/HK/MO | 2 | UTC+8 |
| `global-en` | EN Region | 3 | UTC |
| `global-kr` | Korea | 4 | UTC+9 |

EN 的 UTC 是本站明确的显示约定，不代表官方日界线。SDK 的 app/channel/server 参数来自所支持渠道的应用配置，与上表的游戏服务器编号分别处理。

- `GET /api/growth-export/capabilities/?serverId=global-en`：返回所选 serverId、支持列表、nonce、authMethods 和所选服维护状态。支持的方法目前仅 `email_password`。
- `POST /api/growth-export/read/` 和 `/gacha-history/`：JSON 包含 `serverId`、`account`、`password`。历史客户端省略 serverId 时兼容港澳台；无效区服、额外参数、冲突来源拒绝。
- 沿用同源/Host/Origin、nonce、no-store、限流和并发限制。nonce 不代表玩家登录状态；每次请求新建客户端并独立认证。
- 服务器列表必须同时匹配官方名称、编号及该服固定主机白名单。只有公开发现可访问共同 bootstrap，玩家 RPC 不能跨服。
- `PlayerPreLogin` 未明确存在角色即停止，不注册或创建角色。维护和要求更新使用独立错误码，不误判为密码错误。

养成和抽卡导出均携带真实 `serverId` 与本次 `clientVersion`。前端导入与查询要求来源与当前区服一致；浏览器个人养成仍按区服隔离，旧港澳台来源保留兼容。未读取的养成组保持未知，保留既有账号加成；未知卡片不作为完整卡库保存。

## 客户端版本

`DISCOVERY_VERSION` / 兼容名 `CLIENT_VERSION` 仅是公开发现的起始值，不是固定的实服版本。

1. 共同 `GetServerList` 和所选服务器的公开 `MasterdataService/Version`，分别识别 `client update required` 及唯一、格式合法的 `x-client-recommended-version`，各最多重试一次。
2. 全部发生在提交玩家凭据之前；所选服维护也在这里停止。
3. 将协商版本用于该请求的 SDK `app_ver`、RPC 头、PlayerLogin protobuf 和导出来源。共享的 SDK profile 不被并发请求修改。
4. 认证后若再要求升级，停止本次读取，不自动重发密码、不重新登录。

网页网关、桌面本地工具及现有排行榜客户端使用相同逻辑。排行榜成功来源记录实际协商版本；失败但未能确认版本时为 null，另列 discoverySeedVersion，避免把起始值冒充实服版本。

这解决版本号门禁，不代替协议兼容性或数据内容更新验证。

## Google 游戏授权边界

本站 OAuth 不等于游戏认可的身份。Android 侧授权码与游戏配置的 server client 绑定，网页回调也须符合官方登记来源；目前没有验证可供本站使用的游戏身份交换闭环。不能通过增加按钮宣称已经接通，也不要求玩家提供 Google 密码、Cookie 或令牌。

如果官方客户端支持将身份绑定邮箱，须以同一区服、同一已有角色对账后才能使用邮箱入口；不自动绑定或创建新账号。

## 修改与交付验证

自动测试覆盖三服路由、跨服拒绝、已有角色、每次独立认证、全链路版本一致、公开升级上限、认证后不重试、维护、代理参数、前端保存和时区。自动测试用合成 SDK 配置验证。Git 源码不包含真实配置；本地工具发行 ZIP 内置最小应用配置，启动时自动载入，详见[本地工具说明](../../packaging/growth-tool/README.md)。网关与网站代码分别交付，保留生产配置；实际账号读取、游戏内对账和桌面二进制安装是独立验收。
