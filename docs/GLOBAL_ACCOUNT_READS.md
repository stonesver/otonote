# 三服邮箱认证与账号读取

## 本次范围与状态

支持港澳台、EN、韩服的 BHK 邮箱密码认证、养成读取及抽卡查询。每次读取重新完成 SDK 和游戏认证，不缓存玩家密码、令牌或跨请求身份；App 暂不开发。Google 游戏授权未接通，不将本站 Google OAuth 当成游戏身份。

代码和实服读取已完成，但韩服完整养成导入尚有公开资料库更新门槛：实测账号含当前网站未收录的卡牌。导入会安全拒绝，不静默丢卡后覆盖原档案；发布前需更新公开内容并复验。

## 区服与 API

| serverId | 官方名称 | 游戏服务器编号 | 记录展示时区 |
| --- | --- | --- | --- |
| `global-hmt` | TW/HK/MO | 2 | UTC+8 |
| `global-en` | EN Region | 3 | UTC |
| `global-kr` | Korea | 4 | UTC+9 |

EN 的 UTC 是本站明确的显示约定，不代表官方日界线。SDK 的 app/channel/server 参数仍来自所支持渠道的私有配置，与上表的游戏服务器编号分别处理。

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

## 2026-10-18 实测

用户授权使用现有榜单探测账号。凭据只从服务器既有受保护目录读取，测试使用采集互斥锁、受限临时容器并自动清理，没有部署、重启或更改运行配置。

| 区服 | 角色卡 | 留影 | 抽卡批次 | 奖品条目 | 客户端版本 |
| --- | ---: | ---: | ---: | ---: | --- |
| EN | 26 | 15 | 6 | 24 | 自动协商 1.0.6 |
| 韩服 | 36 | 21 | 7 | 43 | 自动协商 1.0.6 |
| 港澳台对照 | 36 | 28 | 8 | 62 | 自动协商 1.0.6 |

EN/韩服响应未观察到乐器和角色评级，保持未读取。三服总 Master 版本不同，但本次公开清单中成员卡、留影、等级、乐器、角色评级、卡池、奖品及商品等关键表的摘要一致；此结论仅对应本次观测，不能外推未来所有版本。

随后将 EN/韩服清洗后的响应经服务器匿名管道交给真实前端转换器，在内存中使用网站当前公开规则校验：

- EN 养成转换成功，26/15 张卡片可在内存中的对应区服档案保存。
- 韩服养成被旧网站资料缺卡拦截，没有部分覆盖或数据丢弃。
- 两服抽卡均成功建立统计模型；旧资料分别缺少 3/4 条奖品映射，保持未知，不猜卡或 UP。
- 真实快照不落盘、不传回本地；临时容器关闭日志，只保留检查状态与数量。未进行游戏客户端 UI 人工对账。

Playwright 使用明确的合成服务验收 EN/韩服真实组件：养成预览、确认保存、独立抽卡读取、区服隔离、UTC/UTC+9 和密码框清空均通过。合成浏览器验收不能冒充真实游戏 UI 对账。

## Google 可行性

已核对既有 Global Android 1.0.2 的 `GoogleLoginImp.init` 和 `GoogleLoginActivity.doSignIn`：

- 使用游戏配置的 `server_client_id` 调用 `requestServerAuthCode`；申请 email/profile。
- 向官方 `/gapi/client/sns.login` 提交 `channel_type=1`、`google_code` 和 `third_access_token`，部分场景还带 ticket。
- 这是游戏接受的身份交换；本站自建 Google OAuth 的 client 和令牌不自动等价。

Google 的 [服务端授权说明](https://developer.android.com/identity/legacy/gsi/offline-access)要求授权码与 server client 对应，[网页 OAuth 说明](https://developers.google.com/identity/protocols/oauth2/web-server)要求回调匹配登记地址。当前没有验证本站域名可用的、游戏认可的授权回调闭环，所以不能承诺现在加按钮就能登录。也没有证明所有官方支持的集成路径都不可行。

如果官方客户端能将 Google 身份绑定邮箱，仍需以同一区服、同一已有角色对账，才能把邮箱入口作为该账号的替代方式；不自动绑定、不创建新账号，也不要求用户复制 Cookie/令牌或提供 Google 密码。

## 验证和发布

自动测试覆盖三服路由、跨服拒绝、已有角色、每次独立认证、全链路版本一致、公开升级上限、认证后不重试、区服维护、代理参数、前端保存和时区。源码包使用合成 SDK 配置验证依赖完整性，不包含私有配置。

合并到今日集成分支不代表已上线。发布需同时更新网关和网站代码，保留已有生产配置；韩服完整导入和未知奖品映射还需刷新公开内容库后复验，游戏内数量/奖品人工对账仍待完成。


本轮最终验证：74 项 Python 回归、50 项前端回归通过；4 项源码分发回归在合成 SDK 配置下通过。Web 独立构建成功（54 路由、59 交互脚本，codeId `cf6ec80c1ffb6819d394f966`）。源码分发不等同于 Windows/macOS 二进制安装验收。

本轮尚未取得可用于新内容发布的解码资料，本文没有通过放宽导入校验规避内容库缺卡。韩服真实完整导入需随新内容库发布后复验；不将当前这项门槛报告为通过。
