# 玩家榜采集运行约定

## 三服任务与版本升级

`--server` 明确选择 `global-hmt`、`global-en` 或 `global-kr`，默认保持港澳台。SDK 语言、官方主机、已有角色检查、榜单来源及发布目录均使用相同区服。公开版本协商发生在账号认证前，SDK 与游戏登录使用本次协商版本；不通过修改固定版本号维护客户端兼容。

EN/韩服从网站已验证的 Global 投影选择活动，但每轮认证前必须核对公开内容 manifest 的 `releaseRecord.masterVersion`，再比较该港澳台来源版本与目标服当前官方 Master 清单中的 `MasterEvent`、`MasterChallengeMusic`、`MasterLiveMusic`、`MasterText` 四张表的 SHA-256 和长度。只接受固定官方 CDN 主机、对应区服路径、完整且不重复的表记录；拒绝重定向。表不一致返回 `ranking_region_event_tables_differ`，来源或清单不可验证返回 `ranking_region_event_verification_failed`；两者均在 SDK 登录前停止且不覆盖旧榜单，后续周期可重试。榜单来源保存比较证据。

活动时间继续使用网站既有 `Asia/Taipei` 计划，不根据网页语言或抽卡显示时区转换。此适配仅覆盖活动表一致的区服；不同活动配置需要独立投影。EN/韩服的显式 `--master-dir` 维护计划缺少内容版本绑定时拒绝认证。

新增 `capture@.service/.timer` 与 `finalize@.service/.timer` 模板，分别以 `global-en`、`global-kr` 实例启用。每服独立 observations、state、暂停状态及最终归档；港澳台保留原有服务名称和路径。所有六项正式任务先在主机端通过 `dispatch.lock` 最多排队 120 秒，再由同一个 `--lock-dir` 采集锁保护登录，共用既有只读 credentials 与 SDK 挂载，不复制凭据。服务总超时 310 秒，覆盖排队与原有执行预算。直接维护入口遇到采集锁忙仍跳过本轮，不改变快照或暂停状态。

上线前备份现有镜像身份、服务文件、私有 env 和状态；从干净基础镜像构建并固定新采集镜像，验证其中包含 `ranking_regions.py`、最新共享认证模块且不含 SDK。准备共用锁目录和两服 state（UID/GID 10001、0700）以及 observations（UID/GID 10001、0755）。切换期间先暂停采集/归档 timers 并确认任务空闲，检查各服已有暂停原因，不自动 `--resume`。安装单元、更新镜像 pin 后依次人工运行三服采集，核对真实 `serverId`、`eventId`、`clientVersion`、新鲜度和公开接口，再恢复原有约十分钟周期及新增区服 timers。失败时停止新增 timers，恢复旧单元、env 与镜像；保留所有快照、归档和安全暂停状态。旧镜像受上游版本限制，回滚本身不代表恢复采集。


## 程序、配置和数据

- 程序镜像由经过验证的源码构建，部署记录固定镜像 ID 或 digest。每次公开发现得到的 `game.client_version` 同时用于 SDK、游戏请求和榜单来源记录；榜单 protobuf 解码规则的历史来源版本单独说明。
- 真实 `capture.env`、SDK XML、账号和密码只存在于受保护的运行目录。仓库仅保存 `deploy/player-rankings-capture.env.example` 字段模板。
- 定时采集读取网站 `/content/current.json`，逐层校验 manifest 与 `projection/game-modes.json` 的 SHA-256，按 `Asia/Taipei` 的开始、结束时间选择唯一正在进行的 Global 活动，并从同一份公开投影取得歌曲和榜单开关。网站发布新活动内容后，下一次采集自动使用新活动。维护时仍可用 `--master-dir` 与 `--event <ID>` 从私有同版 Master 显式指定活动；正式 service 使用 `--event auto`。
- `RANKING_SDK_RESOURCES` 指向宿主机私有 SDK XML，运行时只读挂载为 `/run/ranking-sdk/resources.xml`。容器 UID 10001 必须有读取权限；宿主目录保持受限。不要把真实 XML 加入构建上下文。
- 账号和密码继续由已有 credentials 目录只读挂载；榜单 observations 和运行 state 继续沿用既有持久目录。
- 必须从干净 Python 基础镜像构建。不能将包含 SDK XML 的旧采集镜像作为基础镜像，再通过删除文件宣称完成脱敏；旧镜像层仍能恢复文件。

## 故障定位

运行状态只记录固定错误码、阶段、`clientVersion`、`discoverySeedVersion` 和公开活动 ID；未能确认实际版本时 clientVersion 为 null。阶段依次为选活动、配置、发现服务、SDK 登录、检查已有角色、游戏登录、读取榜单、原子发布。没有进行中的活动时状态为 `waiting/no_active_event`，不登录或覆盖旧快照；公开内容不可访问、哈希不符、活动时间异常或重叠时为 `ranking_event_selection_failed`，不永久暂停，下次调度重试。不要打印请求头、远端错误文本、账号或 SDK XML。


无重试地停止认证、限流和角色异常的现有策略继续保留。整个采集成功前不替换历史榜单；读取失败不刷新观察时间，也不将旧数据标为新鲜。

## 迁移与回滚

1. 私下记录旧镜像 ID、服务文件摘要及外置配置备份；不输出真实配置。
2. 从已验证来源将 SDK XML 存放到外部受保护文件，确认可由容器 UID 10001 读取。只比较摘要，不打印内容。
3. 构建干净镜像，验证源码版本、离线采集测试及镜像内不存在 SDK XML；记录最终镜像 ID。
4. 将外部环境文件中的镜像值替换为固定镜像 ID，并补充 SDK 资源路径；安装使用 `--event auto` 的新版 service 单元。确认宿主机可访问网站当前 Global 内容，且活动投影含当前活动；保留调度周期、凭据和持久数据目录。旧 `RANKING_EVENT_ID` 与 `RANKING_MASTER_DIR` 不再被 service 使用。
5. 先只读检查现有 `status.json` 是否 `paused`，并按固定错误码处理原因；认证或限流暂停不得因换期自动解除。修复后必要时通过正式入口带 `--resume` 执行一次。检查状态中的 `eventId`、阶段、结果，以及公开接口的活动 ID、观察时间和新鲜度；不另外创建自动登录或无限重试。
6. 若失败，保留最后成功榜单及当前安全暂停状态，按故障阶段处理。回滚需恢复旧镜像和旧 service 组合；旧版本仍可能被上游拒绝，不得将回滚声明为采集恢复。

离线验证：`python3 -m unittest tests.test_player_ranking_collection tests.test_player_rankings tests.test_ranking_regions tests.test_ranking_finalizations`。实际环境配置和私有迁移记录不随此文档提交。

## 活动结束后的最终榜单

- `ournotes-player-rankings-finalize.timer` 每约 10 分钟触发独立任务。任务读取并校验网站当前 Global 活动投影，选择已结束、含已支持榜单且尚未归档的活动，结束后的首次调度即可采集（取消额外 10 分钟等待）；一次只处理一期。它与在线采集共用 `capture.lock`，状态写入独立的 `finalize-status.json`。
- 任务重新登录并读取游戏最终榜单，全部验证成功后只创建 `observations/global-hmt/archive/event-<ID>-post-end.json` 和同名 `.meta.json`。归档文件使用不可覆盖创建；元数据包含活动身份、采集时间和 SHA-256。已有归档仅补齐缺失的元数据，不重新抓取或改写原数据。失败时保留待重试状态，不改动 `current.json`。
- 部署时先核对归档文件的活动 ID、结束时间与摘要，再确保 `archive` 目录为 `0755`、归档文件与元数据为 `0644`，使只读排行榜服务可以访问。元数据不包含玩家信息；不要在部署日志中输出完整榜单。页面会把归档活动列入选择框，历史快照保留原采集时间。
- 回滚时停用并停止 finalizer timer/service，恢复旧采集镜像和旧的排行榜后端目录链接；不要删除已生成的归档。现有 `current.json` 和历史归档应分别核验。

- 每次自动采集保存已验证活动的开始、结束时间、榜单读取计划及内容来源证据到私有 state/event-plans（目录 0700、文件 0600），不保存玩家资料或凭据。归档任务优先处理最早结束且未归档的计划；公开新版本移除旧活动时仍保留补采依据。一次只补一期，不解除认证暂停，失败不创建最终记录。新活动与归档任务继续约十分钟调度并共用登录锁。
- 公开查询中最终归档优先于同活动的旧 current，返回 isFinal=true、eventState=ended、expiresAt=null。页面展示“已结束 · 最终记录”，不按实时 TTL 报过期；活动结束但尚无最终读取的情况显示“等待最终采集”。
- 新快照仅额外保留榜单返回的头像卡标识及固定官方 HTTPS CDN 名片图片。忽略非允许来源、查询参数与私有资料字段；旧归档不改写补字段。网页使用本区服内容资源展示封面、头像及活动加成属性图标，页面配色不随乐队改变。
