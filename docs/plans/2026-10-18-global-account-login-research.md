# 国际服账号登录与复用调查

调查时间：2026-10-18（Asia/Shanghai）。基线：`4c8911bc47e29cee213d72e96e63a87a7f54fc5d`。
当前集成分支：`codex/release-2026-10-18`。本文记录调查与维护提示实现；三服账号读取的后续实现与验收见 [三服读取说明](../GLOBAL_ACCOUNT_READS.md)。用户已决定暂不开发 App。本文其余调查描述保留当时基线。

**最终决定：用户已取消短期会话。保持每次查询独立认证，不保存跨请求密码、官方令牌或本站登录会话；后续仅复用代码与明确的只读接口。**

## 给其他开发对话的交接文本

```text
今天的集成/发布分支为 codex/release-2026-10-18。
新任务请从该分支建立独立任务分支，并使用独立 worktree 开发；已有任务保留现有成果，合并前检查与今日集成分支的差异。
完成开发后运行相关测试、检查差异，将成果合并到 codex/release-2026-10-18，不直接合并 main。
交付说明包含改动、验证结果和待验收项。合并前确认集成分支的最新状态，保留其他任务的修改。
账号登录、养成导入和抽卡记录的公共登录层由当前对话推进；涉及这些接口时先协调契约。
推送和部署按用户另行授权执行。
```

本分支已在共享本地仓库创建，尚未推送远端。起点与本次调查时本地 `origin/main` 引用相同；没有执行 fetch，不据此声称远端之后未发生变化。

## 公开服务器列表：已实时验证

通过项目已有公开只读客户端调用 `PlayerLoginService/GetServerList`，没有登录玩家账号。

- 源码固定的客户端版本 `1.0.3` 收到 `ClientUpdateRequired`，返回要求版本 `1.0.6`。
- 使用返回的 `1.0.6` 再次请求成功，返回三个区服及各自的 API 主机。

| 网站区服标识 | 官方列表名称 | 游戏服务器编号 |
| --- | --- | --- |
| `global-hmt` | `TW/HK/MO` | `2` |
| `global-en` | `EN Region` | `3` |
| `global-kr` | `Korea` | `4` |

这些游戏服务器编号不等于 SDK 的 `server_id`、`channel_id` 或品牌/地区编号。SDK 渠道与游戏区服必须分别建模。

[官方开服 FAQ](https://bdon.biligames.com/details/?id=181789993093106864)也明确列出三个区服，并说明各服游戏数据独立、不互通。网站语言不能用作玩家所属区服。

以上只验证公开发现接口。不能据此声称账号认证、养成读取或抽卡记录查询已通过 EN、韩服验收。

## 登录方式：在线配置与客户端证据

使用仓库外的现有 Google 渠道应用配置，请求官方 SDK 的只读 `/gapi/client/config`。分别以 `lang=en`、`lang=ko`、应用版本 `1.0.6` 请求，两次均返回 `code=0`：

| 开关 | 英文模式 | 韩文模式 |
| --- | --- | --- |
| `config_login_switch`（账号密码入口） | `1` | `1` |
| `config_enable_google_login` | `1` | `1` |
| `config_enable_apple_login` | `1` | `1` |
| `config_enable_facebook_login` | `0` | `0` |
| `config_enable_twitter_login` | `0` | `0` |
| `config_sms_login_switch` | `0` | `0` |
| `config_tourist_login_switch` | `0` | `0` |

该配置请求不包含游戏区服选择；它验证共享 SDK 在所测渠道与语言下的开关，不能外推成所有发行渠道、所有平台、所有账号都已实测。

本地既有 Global Android 1.0.2 官方 APK 提供静态调用证据，SHA-256：`e5786b7ddada9134f1bba7c0eac2f0c5a57f1defeba40f8f8b3e1db27065bc07`。旧包证据与本次在线配置分开记录，不称为 1.0.6 反编译结果：

- `com.gs.android.menu.LoginMenuActivity` 按配置决定显示账号、Google、Apple 入口。
- `GoogleLoginImp.init` 使用游戏配置的 `server_client_id`，请求 Google server auth code。
- `GoogleLoginActivity.doSignIn` 向 SDK `sns.login` 提交 Google 授权材料。
- `AppleLoginWebActivity` 使用游戏配置的 Apple client ID 与官方回调地址发起授权；`AppleLoginActivity.doSignIn` 向同一 SDK `sns.login` 交换身份。
- 英文与韩文资源具有相同的应用/渠道配置。该 APK 的发行渠道与现有 Google 渠道不同，不能把它的应用参数直接覆盖进现有配置。
- SDK 包含绑定邮箱的界面与流程，资源也明确提示角色冲突；未用真实账号验证“第三方账号绑定邮箱后，密码登录仍读取同一角色”。该路径目前仅为候选。

没有调用玩家登录、注册、绑定、发邮件、修改密码或游戏读取接口。没有保存应用密钥、签名、玩家凭据或完整 SDK 响应。

## 现有复用范围

现有短链路：

```text
养成 / 抽卡页面提交账号密码
  -> GrowthGateway.read_growth
  -> GameClient.discover + SdkClient.login
  -> GameClient.authenticate
  -> GetPlayerData 或 GachaService/History
```

代码已经复用，登录会话尚未跨功能复用：

- `tools/growth_web.py` 的 `read_growth` 每个请求都新建 SDK 与游戏客户端，再完成认证。
- `tools/gacha_history.py` 的 `GachaHistoryClient` 继承 `GameClient`；其 `export` 与养成导出一样先调用 `authenticate`。
- 网关不向浏览器发放可供后续功能使用的登录会话；两项功能各自提交账号密码。
- `docs/GACHA_HISTORY.md` 明确当前每次查询重新认证、抽卡记录只在当前页面内存保留。这是现有行为契约，改变会话生命周期时需要同步更新。

现有港澳台绑定点：

| 位置 | 当前限制 |
| --- | --- |
| `tools/growth_login.py` | 固定客户端版本、SDK 应用参数、游戏主机白名单、港澳台服务器匹配及登录请求字段 |
| `tools/growth_web.py` | 单一 SDK profile；能力响应固定港澳台；请求仅接受账号密码 |
| `tools/growth_login.py` / `tools/gacha_history.py` | 导出来源固定港澳台 |
| `site/src/lib/account-growth-ui.mjs` / `gacha-history-ui.mjs` | 仅港澳台开放网页登录 |
| `site/src/lib/account-growth-import.mjs` | 导入校验与清洗后来源固定港澳台 |
| `site/src/lib/gacha-history.mjs` | 只接受港澳台来源；时间分日和展示固定 UTC+8 |

`game-servers.mjs` 已定义三服标识；`personal-growth-store.mjs` 已按区服独立保存养成，适合作为后续适配的基础。EN、韩服的日期展示及游戏日界线仍需分别核对，不能沿用港澳台假设。

图索引用于前端调用链查询；覆盖检查显示 `tools/` 被索引规则排除，因此上述 Python 结论来自直接读取源码。

## 接入边界与待验收

三服后续按区服适配邮箱认证与功能读取，每次查询独立认证。短期会话已经取消，不作为后续实施候选。

第三方登录不能由“资料站自己的 Google/Apple 登录成功”直接推导为“游戏登录成功”。Google 要求客户端及已登记的回调配置匹配；结合客户端使用游戏自身 client 的证据，目前无法承诺添加普通网站 OAuth 按钮就能获得游戏接受的身份。参考 [Google OAuth 官方文档](https://developers.google.com/identity/protocols/oauth2/web-server)及 [Apple 网页登录配置](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple)。这是接入限制的判断，尚未证明所有可行的官方授权路径均不可用。

## 实施与验收仍需完成

- 已确定不引入短期会话；三服邮箱及第三方授权分别验证。
- 在经过验证的应用/渠道配置下完成 EN、韩服本人账号认证；无角色时停止，不能通过读取入口创建角色。
- 分别读取两服养成与抽卡记录，并与游戏内同一账号、同一区服的结果对账。
- 验证不同浏览器、不同玩家、切换账号和切换区服不会串用凭据或数据。
- 验证每次查询独立认证，跨请求不保存或复用玩家凭据。
- 保留现有读方法白名单、来源检查、限流、日志脱敏及 no-store 边界，补充针对改动的离线与浏览器验证。
- 核实当前客户端版本的实际协议兼容性；仅更新请求头不能代替新版本验证。

维护提示实现和验证见后文；没有推送或部署。

## 需求扩展与 haneoka-app 复核

用户补充：手机端 Android APK / iPhone 应用，以及现有工具读取官方游戏 APK / IPA、跟进客户端更新，两部分均需要。下述为调查和候选设计，尚未实施。

### 旧工具现状

- `packaging/growth-tool/launcher.py` 启动本机 HTTP 页面，读取 SDK XML。
- `tools/growth_login_local.py` 仍联网请求官方 SDK 和游戏服务；“本地”表示凭据从自己的电脑发送，不表示无需联网。
- 现有构建器提供 Windows x64 与 macOS arm64 便携包，没有手机构建入口。`tools/build_growth_macos.py` 的回执明确 `appleNotarized: False`。
- 登录版本仍来自 `tools/growth_login.py` 的固定 `CLIENT_VERSION`；本地启动器中没有远程更新检查。
- 另有开发诊断 `tools/growth_cache_export.py`，已经能从 Android 本地缓存提取部分养成，但固定检查游戏 `1.0.1 / versionCode 25`，TGW 标记为未持久化验证。它不是已完成的通用存档导入器，不能简单去掉版本检查就宣称兼容新版。
- `analysis/parse_ournotes_apk.py` 有 Android 清单解析研究代码，但入口和输入路径固定，不能直接当作终端用户 APK / IPA 导入组件。

### 参考项目实际采用的路径

本次固定审阅 [haneoka-app 提交 947b975e3844762187b28e2f4e106bd1796547c8](https://github.com/haneoka-gakuen/haneoka-app/tree/947b975e3844762187b28e2f4e106bd1796547c8) 的相关源码，没有运行该项目或安装其产物。

| 目标 | 源码及结论 |
| --- | --- |
| Android 导入 | `lib/sources/android.dart` 与原生 `SaveChannel.kt` 使用 Shizuku、获准目录；原生层将目录选择支持限定在 Android 13 之前。桌面另有 `lib/sources/adb.dart`。仍需实际设备权限与系统版本验收。 |
| 普通 iPhone 导入 | `lib/sources/ios_direct.dart` 明确普通安装使用电脑导出的存档/备份；直接读取只针对已经具有跨应用目录访问能力的环境。`ios_backup.dart` 实现本地备份读取，包含加密备份解锁路径。 |
| 统一处理 | 文件、目录、备份和设备读取均交给 `SaveCollector`，组合本地文档，再提供展示和导出。它与在线游戏认证属于不同入口。 |
| Google 等登录 | `lib/account/haneoka_account.dart` 的来源是 `https://haneoka.org`，OAuth 指向其 `/api/v1/account/app/oauth`；这是 haneoka 自己的网站账号，不是 BHK 游戏认证。 |
| 数据导出 | `lib/save/export.dart` 提供 `haneoka-game-save-v1` JSON，以及 gzip + Base64 的 `ONPKG1:` 养成文本。 |
| 应用更新 | `lib/core/app_updates.dart` 查询 GitHub 最新稳定版本及平台产物；`lib/ui/app_updates.dart` 显示提示并打开下载链接，没有在此链路中静默安装。 |
| iOS 构建 | `.github/workflows/release.yml` 生成需后续签名安装的 IPA，并另有特定环境专用包；生成 IPA 不能等同于普通用户可直接安装。 |

参考代码的图查询仅索引本次选择的十个文件，完整性边界限于这些来源；关键判断另以源码核对，未将局部图查询当成整个仓库的穷尽证明。

可优先参考的是“多来源采集 → 统一存档 → 最小养成导出”的边界，以及平台更新提示。Android 权限入口与 iOS 备份导入也有参考价值。其 Google 网站登录流程不构成游戏 Google 登录方案。

### 兼容其导出时必须补足的语义

- `ONPKG1:` 只携带成员卡、留影、角色和乐器等位置数组；没有完整抽卡历史、TGW 或三服身份。缺失值应保持未知，不写成零，不清空已有数据。
- 全量 JSON 将国际版标记为 `intl`，并移除 `_cpServerId`、`_cpServerName` 等身份字段；不能据此自动判定港澳台、EN 或韩服。导入必须要求明确区服，并保留文件来源与新鲜度。
- 文件导入证明的是“这些文件包含什么”，不是“用户已完成官方账号认证”。缓存也不保证含有服务端抽卡历史；抽卡记录继续以独立在线读取证据为准。
- 官方游戏 APK / IPA 提供程序、版本及可解析配置，本身不包含该玩家的个人存档。包解析与账号数据导入分别设计。

### 自动更新的三个层次

1. **游戏要求版本和渠道配置：** 复用已有公开发现协议中的升级信号，解析经过核验的官方 APK / IPA 元信息；按平台、发行渠道和包身份记录，不把所有包覆盖成同一个 SDK profile。
2. **协议与解码兼容：** 版本号变化时先验证登录请求、响应结构及存档解码；兼容范围已确认后发布对应兼容资料。不能仅修改请求头、删除旧版本门禁，或执行未经验证的远程代码。
3. **工具自身更新：** 桌面与 Android 检查受信任的版本清单，提供符合平台要求的更新入口；iOS 采用选定的签名分发渠道更新。游戏包更新与导入器更新不是同一动作。现有无更新逻辑的旧便携包需要先换装一次新版。

Android 覆盖更新需保持应用身份与签名兼容，参见 [Android 更新文档](https://developer.android.com/google/play/app-updates)。iOS 普通应用的数据访问受沙箱约束，参见 [Apple 运行时安全文档](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web)；测试分发可使用 [TestFlight](https://developer.apple.com/testflight/)。具体采用哪种发布渠道需在移动端设计阶段确定。

IPA 版本识别和完整 SDK/协议提取分别验收；当前没有实际 IPA 样例证据，不能承诺所有发行包都能完整解析。缺少有效签名分发条件时，也不能把 iPhone 构建通过报告为可安装交付完成。

### 建议的工作包

1. 三服账号路由、公共认证代码、每请求独立的功能专用只读读取；同时消除登录链路版本固定问题。
2. 官方 APK / IPA 身份与配置读取、兼容资料与工具更新机制；保留旧版本回放材料。
3. 本地存档与 haneoka 导出适配，复用网站现有预览、区服校验及保存流程。
4. Android / iPhone 导入器及桌面分发升级，接入上述能力并完成平台安装和更新验收。

Google / Apple 直接游戏授权作为第一工作包内独立的可行性验证项，验证成功后接入共同的无状态认证代码；未跑通时继续提供可取得文件的本地养成导入，不把网站 OAuth 或文件导入冒充游戏认证。上述工作包最终都汇入今日集成分支，可分次完成可审阅的交付。

## 会话成本、参考实现不足与维护提示补充

用户告知当前游戏正在维护。本轮后续不进行账号认证或以账号尝试探测恢复。此前成功的公开服务器发现和 SDK 配置读取，不证明账号登录服务可用。

### 已取消会话及现有线路边界

用户明确拒绝短期会话：不新增登录 Cookie、会话库、KV、Durable Objects 或凭据缓存。维护状态缓存只包含三服公共状态，与账号身份无关。

当前源码网关限制为同时读取 2、每滚动 60 秒启动 24 次；部署模板为 192 MiB、0.35 CPU。它们不代表线上实测容量。本次未更改 CF、在线缓存规则、资源限制或反向代理超时。

### haneoka-app 中应改进或不直接沿用的部分

以下限定于前述固定提交及已审阅的导入/导出链路，不是完整安全审计，也未复现生产事故：

1. `GameRelease` 将国际发行包统一归为 `intl`，完整导出又过滤细分服务器字段；不足以满足本站港澳台/EN/韩服的隔离要求。沿用本站明确的 `serverId` 契约，缺少身份时要求选择并确认，不凭包名猜服。
2. 全量导出是复制大量存档字段后按黑名单删除身份字段，后续游戏新增字段时可能漏过滤。本站继续使用已有养成字段白名单，原始存档尽量只在本地处理。
3. `FileSaveSource._archive` 中能看到单条大小检查，但该路径没有累计解压大小、条目总数和总处理时间的预算；目录遍历有深度限制，但同样要考虑大量文件。本站需要总预算、可取消与后台解析，避免移动端卡顿或内存耗尽。
4. `ONPKG1:` 不携带 TGW、完整抽卡历史与三服身份。适配时必须呈现导入覆盖范围；未知字段不作为零值替换已有养成。它适合其自有用途，不能直接作为本站完整账号快照。

仅借鉴多来源采集和兼容格式，继续使用本站 `personal-growth-store`、区服隔离、预览确认、撤销和现有计分输入规则，不搬入另一套账号库、配队或云同步体系。

### haneoka 自有账号、同步与产品范围

额外审阅同一固定提交的 `lib/account/haneoka_account.dart`、`lib/ui/import_screen.dart`、`lib/save/account_store.dart` 与 `lib/shell/routes.dart`：

- 用户可以登录 haneoka 自己的网站账号，然后关联游戏身份。`link` 向 `/api/v1/account/game-accounts` 提交区服、玩家 ID、名字、可见性、存档时间和 `summaryOf` 摘要。
- 摘要包括等级、经验、评级、卡片数量、喜爱角色卡和歌曲完成数量等；**不是完整存档云备份**。完整存档由 `AccountStore` 写入应用本地私有目录。
- 已关联账号在再次导入后调用 `syncIfLinked` 更新网站摘要；无需先手动导出 JSON 再上传。尚未关联时不自动创建关联。
- 新关联的底层 `link` 在未显式传入可见性且无旧设置时默认 `public`。本站若将来做类似能力应要求明确选择，默认私密；本轮未验证该项目线上 UI 最终传参。
- Flutter 原生路由还涵盖图鉴、公告、日历、社区、剧情、谱面播放、配队、Live2D/Spine、表情制作及小游戏等。这是覆盖网站大量能力的原生客户端，不只是文件导入器或网页套壳。此结论来自源码，未安装其应用验证。

本站目前更适合优先完善移动网页、现有桌面本地工具和明确区服的文件导入。若真实设备验证证明 Android 本地读取是主要障碍，再做薄的 Android 导入助手；iPhone 先走电脑备份/文件导入。普通 iOS App 受沙箱限制，增加 App 本身不能让它读取游戏私有目录。完整复制网站到原生客户端会增加 UI、签名、分发和兼容维护成本，当前没有足够收益证据。用户要求的 APK/IPA 包解析与移动安装能力仍是待验证范围，不能把上述产品建议当作已经完成。

## 维护提示：实测与本地实现

2026-10-18 通过三服公开的 `MasterdataService/Version` 实测维护响应，无玩家账号、密码或游戏认证：

- `grpc-message: under maintenance`，并且 `x-maintenance-total: 1`。
- `x-maintenance-start-at: 2026-10-18T02:00:00Z`、`x-maintenance-end-at: 2026-10-18T06:00:00Z`，即北京时间 **10:00–14:00**。
- `x-maintenance-is-emergency: 0`。不转发上游自由文本、原始异常或其他元数据。
- 公开发现接口在维护时仍可成功，不能作为可登录证明。初始 `1.0.3` 的公开请求可按官方推荐版本重试一次；这不会修改账号登录版本或证明新版认证兼容。

本地实现为 `tools/game_service_status.py`、网关公共 `/api/growth-export/status/` 与全站国际版横幅；详见 [维护状态契约](../GAME_SERVICE_STATUS.md)。维护时养成和抽卡前后端均拦截新读取，返回 `503 game_maintenance` 与 `Retry-After: 60`；保留本地文件导入、资料浏览和配队。

预计结束时间不触发自动恢复。网络故障标为未知；公开接口成功只表示未观察到维护信号，不声称游戏登录已通过。恢复后仍由用户主动查询，不自动重放密码或登录。

状态按进程合并刷新、缓存 60 秒，三服并发公开探测，每服每轮最多两次、单次上限 2.5 秒。不保存玩家会话；没有定时后台作业，收到页面/网关请求且缓存过期才刷新。当前公共响应仍为 `no-store`，缓存仅在源站进程内。部署、CF 线路和真实用户账号读取均未验收。
