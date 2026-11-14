# 私有管理页的内容发布流程

`content-r2.yml` 负责 Global/JP 游戏资源生产。管理页在现有“内容发布”中提供最后一步的整批公开审核：Actions 准备候选 → 工作台确认公开 → R2 发布 → 服务器交付。两服卡片综合远端内容与本机 HTML 回执显示更新结果；展开可核对内容 ID、页面代码 ID、HTML 组合和清单摘要。下载入口保持原有行为。

## 日常操作

- 自动追新由配置的调度来源触发 GitHub Actions，无需保持管理页打开。
- 手动更新：在管理页打开 Actions 链接，登录 GitHub，选择 **Run workflow → main → region=global 或 jp → mode=promote**。两服分别运行；`shadow` 仅生产、上传和校验，不切换网站内容。
- 启用审核后，新批次默认待审核。展开概览核对新增条目和变更文件，在工作台选择**立即发布**、填写北京时间后**按此时间发布**，或**暂缓**。Global 一批覆盖港澳台、韩服、EN，时间必须适用于全部区服；JP 单独核对。未知时间保留人工处理，不从解包配置日期推断正式公开。
- 已确认时间保存在候选批次上，工作台服务每分钟检查一次，到期自动提交同一发布工作流，无需保持网页打开。采样、Actions 排队和服务器预渲染都会带来延迟；“已提交”不等于“已发布”。服务重启后会处理仍然到期的批次；网络结果未知时十分钟后才重新检查提交，同一旧版本决定不能再次生效。
- 在 GitHub 查看运行进度、错误和发布结果；发布完成后等待服务器同步和生成页面，回到管理页核对对应内容版本。旧批次被新候选替换时需重新确认，暂缓和定时决定不会自动转移。
- 只有网站功能代码变更时使用代码发布流程，无需重新触发游戏资源生产。
- 旧本机任务折叠在历史记录中，不代表当前 Actions 运行。旧检查、拉取、构建、发布按钮不在 R2 profile 中显示；API 能力汇总也不再暴露这些操作，残留排队任务即使被旧 worker 拾取也会取消。

晋级失败可通过“重试已保存的发布”入口重用运行摘要中的发布编号；操作见[恢复流程](../../docs/runbooks/content-pipeline.md#恢复与回滚)。仅页面交付失败时重试服务器预渲染服务。

管理页后端仅向配置的仓库、默认使用的 `main` 分支和固定 `retry-content-publication.yml` 提交审核决定。GitHub 令牌留在服务器，不下发浏览器；R2 写权限仍只在 Actions。本机交付回执记录内容与 HTML 的本地身份，健康采样器使用既有 R2 只读权限采样审核、运行回执和远端指针。详见[健康采样和回退](../../docs/runbooks/content-pipeline.md)。本机采样缺失、过期或版本不一致时显示“状态待核对”，不能复用旧成功状态。原有未迁移 profile 继续使用原任务合同。

## 配置与安装

先核对线上文件 SHA-256，避免覆盖服务器热修。备份将修改的应用文件、`/etc/ournotes-admin/{admin,node}.json`、状态导出 unit 与 `latest-run.json`；不复制或输出 env 文件、令牌或任务数据库。

1. 更新 `/srv/ournotes-admin/app/backend/admin/` 的应用与静态文件，包括 `publications.py`、`update_health.py` 和 `static/publication-review.mjs`；同步健康采样器及其 `tools.publication_review`、`tools.r2_content`、`tools.materialize_r2_content` 依赖。这里没有新 Python/Node 依赖。
2. 目标 profile 设置 `productionSource: "github-actions-r2"`、`stateWorkspace: "/resource-state"`、`capabilities: []`，名称改为“Global / JP 内容交付”。保留原 profile ID 以维持历史任务关联。移除该 profile 的旧 `workspace`、`configFile`、`publishUsers`；如果节点没有其他本机生产 profile，也可移除顶层 `repository`。新代码读取状态不再需要任何旧更新器路径。
3. [只读节点示例](node.r2.example.json) 仅供核对字段。保留实际环境现有端口、数据库位置、令牌环境变量名与其他 profile；不要用示例整份覆盖生产配置。`writeTokenEnv` 仍是节点认证合同的一部分，但 R2 profile 没有任何可提交的本机生产任务。
4. 新导出器位于 `/srv/ournotes-admin/export_r2_delivery_state.py`，配套 `ournotes-r2-delivery-state.service/.timer` 放到 `/etc/systemd/system/`。停用旧 `ournotes-resource-state.path`，避免覆盖新状态；运行一次新导出器，确认 schemaVersion=2、productionOwner=github-actions-r2 和两服 delivery.regions。
5. 重启 node/admin 服务，等待实际 HTTP API 可用（容器启动不代表 API 已就绪）。检查两服卡片、新 Actions 入口及指南、历史折叠和无旧按钮，再启用新导出 timer。

旧单元、脚本和配置仅在独立清理审计明确其引用与恢复用途后处置；文档整理不删除它们。**保留现有 tasks.sqlite 和审计数据库**；保留管理服务、节点只读 API、新导出器、新 R2 预渲染服务及其挂载。

导出器每两分钟读取本地 pointer、manifest/物化回执、HTML complete.json 和 symlink，比较两服和跨服库身份，不重复扫描媒体文件。完整文件校验由物化任务负责。异常原子写入 unavailable；节点将超过六分钟或明显来自未来的采样判为不可用。界面显示代码 ID 属于生成该 HTML 的代码身份，不应误作 Git 提交号。

### 开启发布审核操作

先完成[内容管线的审核启用步骤](../../docs/runbooks/content-pipeline.md#公开前审核)，再按[管理配置示例](admin.example.json)设置顶层 `publicationReview.repository` 和 `tokenEnv`。令牌仅授予目标仓库 Actions 写权限，放入现有私有 `admin.env`。在 admin 配置的对应 node 上设置 `publishUsers`，复用既有登录账号；node 配置中的 R2 profile 仍是只读，没有本机生产权限。不配置 `publicationReview` 时不启用提交和定时检查。

默认管理服务只允许 loopback 网络。启用审核提交时需要在实际运行服务中放行到 `api.github.com:443` 的出站连接；使用所附 systemd 单元时，在 admin 服务的专用 drop-in 中用空的 `IPAddressDeny=` 清除全网禁止规则，并由主机出口规则限制目的地。node 服务继续保持 loopback 限制。重启后验证真实 GitHub 提交和定时放行，不能用本机模拟提交代替。预览模式始终只读，不启动定时检查。

## 验证与回退

运行 `python -m unittest tests.test_admin_publication_review tests.test_publication_review tests.test_admin_r2_delivery tests.test_admin_upgrade tests.test_admin_analytics`，以及 `node --check backend/admin/static/publication-review.mjs`。浏览器验收待审／定时／暂缓状态、提交结果、ready/过期状态、版本展开和历史折叠，确认刷新不会收起正在阅读的内容或清空正在填写的时间。

应用回退应恢复本次部署备份的应用文件与匹配配置，保留新的 R2 交付 timer。已删除旧管线后不要重新启用旧更新器或旧导出器；旧 UI 无法代表当前 Actions 状态。如需更早且不支持纯 stateWorkspace 的 node.py，须先恢复其兼容配置，不能直接搭配本文件的新精简 profile。
