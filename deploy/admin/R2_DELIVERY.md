# 私有管理页的内容发布流程

`content-r2.yml` 负责 Global/JP 游戏资源生产和公开发布。管理页保留访问统计、服务器负载与认证入口，将“资源任务”改为“内容发布”：Actions 生产 → R2 发布 → 服务器交付。两服卡片显示本机内容与 HTML 已核对的版本；展开可核对内容 ID、页面代码 ID、HTML 组合和清单摘要。

## 日常操作

- 自动追新由 GitHub Actions 定时运行，无需保持管理页打开。
- 手动更新：在管理页打开 Actions 链接，登录 GitHub，选择 **Run workflow → main → region=global 或 jp → mode=promote**。两服分别运行；`shadow` 仅生产、上传和校验，不切换网站内容。
- 在 GitHub 查看该次运行的实时进度、错误和发布结果；`promote` 完成后，等待服务器同步和生成页面，回到管理页刷新，核对对应内容版本。
- 只有网站功能代码变更时使用代码发布流程，无需重新触发游戏资源生产。
- 旧本机任务折叠在历史记录中，不代表当前 Actions 运行。旧检查、拉取、构建、发布按钮不在 R2 profile 中显示；API 能力汇总也不再暴露这些操作，残留排队任务即使被旧 worker 拾取也会取消。

管理页不查询 GitHub API，不持有 GitHub 凭据，也不代用户提交工作流。它显示的是服务器本机的交付回执，不能证明远端没有更新，也不能用来判断 Actions 是否执行中。本机采样缺失、过期或版本不一致时显示“状态待核对”，不能复用旧成功状态。原有未迁移 profile 继续使用原任务合同。

## 配置与安装

先核对线上文件 SHA-256，避免覆盖服务器热修。备份将修改的应用文件、`/etc/ournotes-admin/{admin,node}.json`、状态导出 unit 与 `latest-run.json`；不复制或输出 env 文件、令牌或任务数据库。

1. 更新 `/srv/ournotes-admin/app/backend/admin/` 下 `config.py`、`node.py`、`static/admin.mjs`、`static/admin.css`、`static/index.html`。这里没有新 Python/Node 依赖。
2. 目标 profile 设置 `productionSource: "github-actions-r2"`、`stateWorkspace: "/resource-state"`、`capabilities: []`，名称改为“Global / JP 内容交付”。保留原 profile ID 以维持历史任务关联。移除该 profile 的旧 `workspace`、`configFile`、`publishUsers`；如果节点没有其他本机生产 profile，也可移除顶层 `repository`。新代码读取状态不再需要任何旧更新器路径。
3. [只读节点示例](node.r2.example.json) 仅供核对字段。保留实际环境现有端口、数据库位置、令牌环境变量名与其他 profile；不要用示例整份覆盖生产配置。`writeTokenEnv` 仍是节点认证合同的一部分，但 R2 profile 没有任何可提交的本机生产任务。
4. 新导出器位于 `/srv/ournotes-admin/export_r2_delivery_state.py`，配套 `ournotes-r2-delivery-state.service/.timer` 放到 `/etc/systemd/system/`。停用旧 `ournotes-resource-state.path`，避免覆盖新状态；运行一次新导出器，确认 schemaVersion=2、productionOwner=github-actions-r2 和两服 delivery.regions。
5. 重启 node/admin 服务，等待实际 HTTP API 可用（容器启动不代表 API 已就绪）。检查两服卡片、新 Actions 入口及指南、历史折叠和无旧按钮，再启用新导出 timer。

停用旧 node-worker 和旧状态导出 unit 后，可以在独立清理审计中删除其脚本、配置与旧更新器路径。**保留现有 tasks.sqlite 和审计数据库**；保留管理服务、节点只读 API、新导出器、新 R2 预渲染服务及其挂载。

导出器每两分钟读取本地 pointer、manifest/物化回执、HTML complete.json 和 symlink，比较两服和跨服库身份，不重复扫描媒体文件。完整文件校验由物化任务负责。异常原子写入 unavailable；节点将超过六分钟或明显来自未来的采样判为不可用。界面显示代码 ID 属于生成该 HTML 的代码身份，不应误作 Git 提交号。

## 验证与回退

运行 `python -m unittest tests.test_admin_r2_delivery tests.test_admin_upgrade tests.test_admin_analytics`，以及 `node --check backend/admin/static/admin.mjs`。浏览器验收 ready/过期状态、手动指南、版本展开、历史折叠，确认刷新不会收起正在阅读的内容。

应用回退应恢复本次部署备份的应用文件与匹配配置，保留新的 R2 交付 timer。已删除旧管线后不要重新启用旧更新器或旧导出器；旧 UI 无法代表当前 Actions 状态。如需更早且不支持纯 stateWorkspace 的 node.py，须先恢复其兼容配置，不能直接搭配本文件的新精简 profile。
