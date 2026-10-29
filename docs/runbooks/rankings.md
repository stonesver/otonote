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

## 活动总分榜

活动投影的 `totalMusic` 开关决定总分榜是否适用；适用但未采集时保留入口并明确提示缺失，不混用单曲榜。采集、待归档计划与最终榜读取均支持 `total-music`，继续使用既有账号区服、共享锁、暂停状态和约十分钟运行流程。源码变更需正常重建并固定采集镜像，完成观察服务与网页交付后才影响线上；本地真实读取不代表已经更新生产镜像或定时任务。

Global 1.1.0 已核验 `GetChallengeMusicTotalRanking`：请求字段 1 为活动 ID；响应字段 1 为列表，条目字段 1 为公开资料、2 为官方总分、3 为公开队伍。响应字段 2、3 是采集账号的个人排名与分数，一律丢弃。网站按官方总分和返回顺序展示，不自行累加单曲分数，也不将总榜附带队伍称为取得该总分的固定队伍。

当前港澳台活动真实响应返回前 100 条；该请求没有已核验的范围分页参数，不宣称支持 T1000。网页分页仅遍历已经采集的条目。其他区服、历史活动及结算后的总榜仍需独立真实验收。

## 活动结束后的最终榜单

- `ournotes-player-rankings-finalize.timer` 每约 10 分钟触发独立任务。任务读取并校验网站当前 Global 活动投影，选择已结束、含已支持榜单且尚未归档的活动，结束后的首次调度即可采集（取消额外 10 分钟等待）；一次只处理一期。它与在线采集共用 `capture.lock`，状态写入独立的 `finalize-status.json`。
- 任务重新登录并读取游戏最终榜单，全部验证成功后只创建 `observations/global-hmt/archive/event-<ID>-post-end.json` 和同名 `.meta.json`。归档文件使用不可覆盖创建；元数据包含活动身份、采集时间和 SHA-256。已有归档仅补齐缺失的元数据，不重新抓取或改写原数据。失败时保留待重试状态，不改动 `current.json`。
- 部署时先核对归档文件的活动 ID、结束时间与摘要，再确保 `archive` 目录为 `0755`、归档文件与元数据为 `0644`，使只读排行榜服务可以访问。元数据不包含玩家信息；不要在部署日志中输出完整榜单。页面会把归档活动列入选择框，历史快照保留原采集时间。
- 回滚时停用并停止 finalizer timer/service，恢复旧采集镜像和旧的排行榜后端目录链接；不要删除已生成的归档。现有 `current.json` 和历史归档应分别核验。

- 每次自动采集保存已验证活动的开始、结束时间、榜单读取计划及内容来源证据到私有 state/event-plans（目录 0700、文件 0600），不保存玩家资料或凭据。归档任务优先处理最早结束且未归档的计划；公开新版本移除旧活动时仍保留补采依据。一次只补一期，不解除认证暂停，失败不创建最终记录。新活动与归档任务继续约十分钟调度并共用登录锁。
- 公开查询中最终归档优先于同活动的旧 current，返回 isFinal=true、eventState=ended、expiresAt=null。页面展示“已结束 · 最终记录”，不按实时 TTL 报过期；活动结束但尚无最终读取的情况显示“等待最终采集”。
- 新快照仅额外保留榜单返回的头像卡标识及固定官方 HTTPS CDN 名片图片。忽略非允许来源、查询参数与私有资料字段；旧归档不改写补字段。网页使用本区服内容资源展示封面、头像及活动加成属性图标，页面配色不随乐队改变。

## 舞台玩家排行榜

舞台榜沿用本服务已有的 SDK、独立账号区服、受保护 credentials 和共享登录锁。字段、网页状态及隔离契约见[舞台玩家排行榜](../reference/arena-stage.md#玩家排行榜)。运行时不写活动榜 `current.json`，观察文件按区服、赛季及乐队分别原子发布，已有赛季文件保留用于历史查询。

```sh
python3 -m tools.collect_arena_rankings \
  --server global-hmt --content-base https://<site-origin> \
  --root <observations-root> --state-dir <existing-capture-state> \
  --lock-dir <shared-login-lock-directory> --sdk-resources <private-sdk-resources.xml>
```

默认选择已核验投影中唯一进行中的赛季及已开放乐队，每个乐队默认查询第 1～1000 名，按每页最多 100 名顺序读取，全部乐队共享本轮认证。可用 `--season <id>` 查询已开始的已收录历史赛季，`--band <id>` 限定乐队，`--limit <1-1000>` 收紧区间。本地已受审投影可用 `--projection <arena.json> --projection-sha256 <sha256>` 指定；没有摘要、投影区服覆盖未核验或赛季未发布时不认证。不把配置表一致等同于其他区服账号榜单可用。

认证与限流错误写入固定错误码并暂停本入口；同时尊重同一 state 目录中活动采集、归档任务已有的暂停状态。`--resume` 只解除本入口经人工处理后的暂停，不解除其他采集任务的暂停。不会因下一轮或赛季切换自动重试认证。

采集镜像增加相应模块及 Docker 构建白名单；已有镜像需正常构建、固定并验收，不能仅更换网页宣称线上接口已可用。公开编成复用已有卡牌字段白名单；采集失败不会替换上次完整快照。只读 Query 服务提供 `/api/v1/arena-rankings`，沿用 `/api/v1/` 代理。部署模板 `ournotes-arena-rankings-capture.service/.timer` 以北京时间每小时第 2、12、22、32、42、52 分低频刷新前 1000 名，错开原活动榜整十分任务，仍由共享锁避免同时登录。安装与启用前核对固定镜像、现有挂载和暂停状态；源码合并不会自动安装服务。当前页面刷新只读取已发布观察，不触发登录。

离线验证：`python3 -m unittest tests.test_arena_rankings tests.test_player_rankings tests.test_player_ranking_collection -q`，以及 `node --test site/tests/arena-rankings.test.mjs`。

## 舞台动态名次服务

`python3 -m tools.arena_live` 是按访问触发的独立只读捕获入口，不是 timer。必须由现有受保护挂载提供 `--sdk-resources`、`--state-dir`、`--lock-dir`；credentials 仍只读挂载，不能来自浏览器。默认核对正常内容指针的受审舞台投影，也支持 `--projection <arena.json> --projection-sha256 <sha256>`，范围未核验时在认证前停止。

服务只监听本机回环地址，默认端口 18766；缓存与并发预算见[查询契约](../reference/arena-stage.md#按需名次查询与低频更新)。`deploy/ournotes-arena-live.service` 和 `deploy/arena-live.locations.conf` 是待交付示例；先重建并固定已有采集镜像，再检查共享锁、state 权限、正常内容覆盖和回环监听，最后接入同源路径 `/api/v1/arena-rankings-live`。没有安装或启用这些文件时，网站继续明确展示保存榜单，不能声称动态官方查询已可用。

认证与限流暂停写入独立 `arena-live-status.json`，并尊重其他捕获任务已有暂停状态；重启不解除。人工核验原因后才能处理该文件；不得由网页、健康检查或自动重启清除暂停。无访问时不会登录或请求官方，健康检查 `/healthz` 也不登录。生产安装、重新加载代理和服务启用仍属独立交付操作。

指定名次／范围最多 100 名，一次认证只读一次官方榜单；不聚合更大范围，不自动串行扫榜。默认前 1000 名继续读保存观察文件。段位筛选已移除；人数区读取独立汇总。

本人排名由现有 `tools.growth_web` 网关的 `/api/growth-export/arena-rank/` 处理，不能复用此处的采集小号身份。重建登录网关时须包含 `tools.arena_personal`；沿用 `deploy/growth.locations.conf` 的同源代理，不新增凭据挂载、共享身份或公开观察文件。已安装旧网关未声明 `arenaPersonal` 时，页面明确提示未开放。真实本人响应、三服隔离与版本匹配仍需独立验收，不以本地合成测试代替。

验证：`python3 -m unittest tests.test_arena_personal tests.test_growth_web tests.test_arena_live tests.test_arena_rankings -q` 和 `node --test site/tests/arena-*.test.mjs`。还需核验前后台恢复、名次范围、429、并发合并、过期游标及失败保留结果；测试回放不等于常驻服务上线。

## 官方配对趋势

`tools.collect_arena_trends` 沿用上述 credentials、SDK 与共享锁；该入口只请求官方 `DeckTrend`，不读取账号卡库或操作队伍。以 `--projection <arena.json> --projection-sha256 <sha256> --catalog <catalog.json> --catalog-sha256 <sha256>` 绑定同版受审舞台投影及公开曲目目录；其余 `--server`、`--season`、`--band`、`--root`、`--state-dir`、`--lock-dir`、`--sdk-resources` 参数含义与舞台榜一致。认证前校验区服、赛季、开放状态及歌曲关系，最多顺序查询 200 组。

输出 `arena-deck-trends-<serverId>.json` 是白名单复核输入，权限 0600；经同版复核的记录填入既有 `arenaReview.deckTrends`，由正常内容候选构建和校验后发布。输出文件不自动替换线上投影，不创建 timer；真实凭据、SDK、原始响应和现场日志留在仓库外。卡牌序号不代表使用率，空列表保持为空，不跨区服补齐。展示和字段契约见[官方配对趋势](../reference/arena-stage.md#官方配对趋势)。

离线验证：`python3 -m unittest tests.test_arena_trend_collection tests.test_arena_content -q` 与 `node --test site/tests/arena-trends.test.mjs`。

## 舞台大段位人数探测

复用上文的 `tools.collect_arena_rankings` 命令参数，加 `--population`，切换为大段位人数探测，不执行前 1000 名批量保存。一次选定所需乐队，在同一次认证内顺序探测；每团最多 96 次单条请求，请求间隔和墙钟预算见[人数契约](../reference/arena-stage.md#大段位人数与榜单规模)。同一区服每次尝试后冷却 6 小时；此模式不允许 `--resume` 绕过暂停或冷却。`ournotes-arena-population-capture.service/.timer` 为低频模板，任务结束后至少 6 小时才再次调度；启动抖动不绕过捕获器的持久冷却。模板不会自行安装或启用，正式排程需核对与现有采集的合计负载。

镜像须包含 `tools/arena_population.py` 与 `backend/arena_population.py`。输入投影须有已核验的 `sourceMasterVersion` 与完整源段位覆盖；缺少时在提交凭据之前停止。公开文件为 `observations/<serverId>/arena/season-<seasonId>/population-band-<bandId>.json`，仅含白名单汇总；与 `band-<bandId>.json` 排名条目分开保存。Query 的 `/api/v1/arena-population` 只读这些文件，不持有账号，不接受浏览器触发探测。失败不替换旧汇总，不重写旧时间，认证／限流继续按既有暂停约定处理。

本人、公开排名与人口探测使用不同用途，不能拿采集小号的段位替代分布。`ArenaRewards` 的每团最大名次字段只有客户端证据，进行中赛季可用性尚未验证；当前实现只使用已核验的 `ArenaRanking`。真实人数汇总、榜尾变化时的稳定性与常驻负载均需独立验收；合成分布测试不代表实服已采集。

验证：`python3 -m unittest tests.test_arena_population tests.test_arena_content tests.test_arena_rankings -q`、`node --test site/tests/arena-population.test.mjs`，并完成吸顶、禁用入口、缺失／过期和区服切换的浏览器回归。

## 向现有公开快照加入舞台投影

共享媒体内容可使用 `tools.recompute_published_rankings` 的受审补充入口，在原有完整库存核验、媒体身份核对、不可变写入回读与指针 CAS 流程中同时加入 `projection/arena.json`。必须额外提供 `--arena-review`、`--arena-master-root`、`--expected-arena-review-sha256` 三项；缺一即停止。复核文件的游戏发布身份、区服及 `masterVersion` 必须精确匹配当前公开 manifest 的 `releaseRecord.masterVersion`，表与图标仍逐项核对摘要，不在现有发布目录覆盖文件。

使用新的私有工作目录，先不加 `--publish` 完成本地验证；审查生成投影和回执后，再以相同固定基线执行正式发布。并发指针变化会中止，保留原指针与所有旧媒体。这个补充流程不把复核文件复制到公共资源，不为未核验的新 Master 自动沿用旧条件。正常内容候选仍通过 `arenaReview` 显式绑定同版复核材料。
