# 玩家榜采集运行约定

## 程序、配置和数据

- 程序镜像由经过验证的源码构建，部署记录固定镜像 ID 或 digest。`growth_login.CLIENT_VERSION` 同时用于 SDK、游戏请求和榜单来源记录；榜单 protobuf 解码规则的历史来源版本单独说明。
- 真实 `capture.env`、SDK XML、账号和密码只存在于受保护的运行目录。仓库仅保存 `deploy/player-rankings-capture.env.example` 字段模板。
- 定时采集读取网站 `/content/current.json`，逐层校验 manifest 与 `projection/game-modes.json` 的 SHA-256，按 `Asia/Taipei` 的开始、结束时间选择唯一正在进行的 Global 活动，并从同一份公开投影取得歌曲和榜单开关。网站发布新活动内容后，下一次采集自动使用新活动。维护时仍可用 `--master-dir` 与 `--event <ID>` 从私有同版 Master 显式指定活动；正式 service 使用 `--event auto`。
- `RANKING_SDK_RESOURCES` 指向宿主机私有 SDK XML，运行时只读挂载为 `/run/ranking-sdk/resources.xml`。容器 UID 10001 必须有读取权限；宿主目录保持受限。不要把真实 XML 加入构建上下文。
- 账号和密码继续由已有 credentials 目录只读挂载；榜单 observations 和运行 state 继续沿用既有持久目录。
- 必须从干净 Python 基础镜像构建。不能将包含 SDK XML 的旧采集镜像作为基础镜像，再通过删除文件宣称完成脱敏；旧镜像层仍能恢复文件。

## 故障定位

运行状态只记录固定错误码、阶段、`clientVersion` 和公开活动 ID。阶段依次为选活动、配置、发现服务、SDK 登录、检查已有角色、游戏登录、读取榜单、原子发布。没有进行中的活动时状态为 `waiting/no_active_event`，不登录或覆盖旧快照；公开内容不可访问、哈希不符、活动时间异常或重叠时为 `ranking_event_selection_failed`，不永久暂停，下次调度重试。不要打印请求头、远端错误文本、账号或 SDK XML。

2026-10-02 的受限对照验证：在旧镜像代码中，只修改请求客户端版本，发起两次不带账号的 `GetServerList` 请求。1.0.1 返回 `game_rpc_unknown`，1.0.2 成功且发现主机在现有允许列表内。此证据确认了发现阶段的版本阻塞；账号登录和实际榜单读取需在部署后的正常任务中另行验收。

无重试地停止认证、限流和角色异常的现有策略继续保留。整个采集成功前不替换历史榜单；读取失败不刷新观察时间，也不将旧数据标为新鲜。

## 迁移与回滚

1. 私下记录旧镜像 ID、服务文件摘要及外置配置备份；不输出真实配置。
2. 从已验证来源将 SDK XML 存放到外部受保护文件，确认可由容器 UID 10001 读取。只比较摘要，不打印内容。
3. 构建干净镜像，验证源码版本、离线采集测试及镜像内不存在 SDK XML；记录最终镜像 ID。
4. 将外部环境文件中的镜像值替换为固定镜像 ID，并补充 SDK 资源路径；安装使用 `--event auto` 的新版 service 单元。确认宿主机可访问网站当前 Global 内容，且活动投影含当前活动；保留调度周期、凭据和持久数据目录。旧 `RANKING_EVENT_ID` 与 `RANKING_MASTER_DIR` 不再被 service 使用。
5. 先只读检查现有 `status.json` 是否 `paused`，并按固定错误码处理原因；认证或限流暂停不得因换期自动解除。修复后必要时通过正式入口带 `--resume` 执行一次。检查状态中的 `eventId`、阶段、结果，以及公开接口的活动 ID、观察时间和新鲜度；不另外创建自动登录或无限重试。
6. 若失败，保留最后成功榜单及当前安全暂停状态，按故障阶段处理。回滚需恢复旧镜像和旧 service 组合；旧版本仍可能被上游拒绝，不得将回滚声明为采集恢复。

离线验证：`python3 -m unittest tests.test_player_ranking_collection tests.test_player_rankings`。实际环境配置和私有迁移记录不随此文档提交。
