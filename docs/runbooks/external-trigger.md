# 服务器更新触发器

服务器按北京时间 03:00、14:00、19:00 及已审活动日历触发 `content-r2.yml`，生产、校验和发布仍由 Actions 完成。首次安装保持 timer 停用、原生调度继续工作；专用凭据和双服验收通过后才能切换。

## 调度与回执

- 两服 systemd timer 每分钟检查一次是否到期。固定时点复用 `tools/r2_schedule.py`；活动日历从默认分支的 `config/arena-sync-schedule.json` 读取，走 GitHub Contents API 的公开只读请求，不携带触发令牌。两服共用五分钟缓存，每小时最多十二次正常刷新；过期刷新失败时不静默采用旧日历。
- 仅向固定 GitHub API 域名、指定仓库的 `content-r2.yml`、`main` 分支发送请求，拒绝 HTTP 重定向。使用 `mode=auto`，保留分服启用／自动晋级开关、同服串行锁及手动 shadow/promote 行为。
- 每次只提交最新到期时点，重启后只补一次，不重放积压档位。按区服和计划时间预留请求身份；同一时点跨十五分钟或重复执行也不重复提交。活动日历合并后最多五分钟被读到；Actions 在运行时再次检查区服、绝对日期和最新到期时点，拒绝提前执行及过期请求。
- API 返回运行编号才记录 `accepted`。请求超时、服务端错误或进程中断后，下一次检查按固定运行标题核对远端记录。查不到不代表未受理，因此不盲目重发。明确的 HTTP 429 或额度耗尽的 403 最多提交三次，至少等待一分钟、五分钟，并遵守服务端恢复时间；其他明确拒绝保留失败状态，供处理凭据或配置。
- `accepted` 只代表请求已受理。是否开始、生产成功和页面交付仍看 Actions 运维回执与当前网页身份。`scheduledFor` 保存原计划时点，手动运行不能刷新这个时间来掩盖漏触发。
- 每次网络请求最长十五秒；服务最长五十五秒，内存 64 MiB、CPU 5%。持久文件为两服正式／探针状态、共享日历缓存及锁文件，均在私有状态目录内。令牌不出现在参数、状态文件、错误正文或日志中。

## 凭据和安装

支持 Python 3.6+、systemd 239。建立无登录 shell 的专用用户 `ournotes-trigger`。将受审提交中的 `tools/r2_dispatch.py`、`tools/r2_schedule.py` 放到 `/opt/ournotes-update-trigger/<revision>/tools/`，由 root 拥有；将 `current` 指向该版本。安装两服 timer 和模板 service，保持 disabled。`StateDirectory` 使用 0700 权限；手动验收前可由 root 创建同权限、归属专用用户的状态目录。

为目标仓库配置专用 fine-grained PAT 或 GitHub App 安装凭据，权限为 **Actions: write** 及 GitHub 必需的 metadata。此权限可管理该仓库其他 Actions 运行，并非只能派发指定工作流。不要把个人 CLI 的广权限凭据复制到服务器。需要安排到期更新；触发器读取有效凭据，不自动创建或续期令牌。

令牌文件为 `/etc/ournotes-update-trigger/github-token`，归属 `root:ournotes-trigger`、权限 0640；父目录归属同组、权限 0750。也支持仅所有者可读的 0600 文件。令牌内容不进入仓库、PR、日志或聊天。

## 验收与切换

1. 合并工作流输入、运行回执和触发器改造，通过 CI。`CONTENT_R2_SCHEDULER` 未设置或为 `native` 时保持原生调度，外部定时请求不能启动生产。服务器 timer 此时仍停用。
2. 在服务器核对 Python 编译、systemd unit 和 GitHub API／活动日历连通性；安装专用凭据。
3. 从受审版本目录，以专用用户执行下列命令，分别对 `global`、`jp` 验收。省略 `--scheduled` 表示人工探针，使用独立的十五分钟去重身份，不占用正式定时档位：

   ```sh
   python3 -m tools.r2_dispatch --repository <owner/repository> --region global \
     --token-file /etc/ournotes-update-trigger/github-token \
     --state-dir /var/lib/ournotes-update-trigger
   ```

4. 核对两个 `runId`，等待对应生产结果及双服页面交付。重复调用应复用原编号；API 受理不能代替生产／网站验收。安装支持外部来源和触发告警的管理端及健康采样器。
5. 双服全部通过后，将仓库变量 `CONTENT_R2_SCHEDULER` 设置为 `external`，再启用两服 timer。原生 cron 声明保留供回退，但选择器拒绝其生产任务；只有外部计划请求及显式手动操作可进入生产。既有运行不取消。
6. 在健康采样环境设置 `R2_EXTERNAL_TRIGGER=true`，启用对 `/var/lib/ournotes-update-trigger` 的只读挂载。核对真实 timer 触发、运行编号、外部计划回执及网页交付；观察后续自然时点。

外部模式下，计划到达超过十分钟但没有匹配运行回执时告警；明确拒绝、受理未知及触发器回执超过六分钟未刷新分别报告。活动时点使用触发器回执补充固定档判断。告警只进入现有私有健康视图和日志，不自动发送消息。

回退时先停用两服 timer，再将 `CONTENT_R2_SCHEDULER` 恢复为 `native` 或删除该变量，并关闭 `R2_EXTERNAL_TRIGGER`。原生三档和受审活动 cron 随即重新具备运行资格。保留正在运行的任务及当前公开内容，不回退网站数据。

参考：[GitHub workflow dispatch 与权限](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[返回运行编号](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids/)、[systemd 执行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。
