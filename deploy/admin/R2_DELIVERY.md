# 私有管理页的 R2 交付状态

`content-r2.yml` 负责 Global/JP 生产和公开发布；管理页仅显示本机已物化的内容与 HTML。它不查询 GitHub API，也不把本机同步状态解释为远端最新生产结果。

## 安装前

核对服务器 `/srv/ournotes-admin/app/backend/admin/{config.py,node.py,static/admin.mjs}` 与仓库基线的 SHA-256，避免覆盖服务器热修。备份 `/etc/ournotes-admin/{admin,node}.json`、原两个 Python/JS 文件、原 `ournotes-resource-state.{path,service}` 和 `/var/lib/ournotes-resource-state/latest-run.json`；不复制或输出 env 文件、令牌、任务数据库。确认 `/srv/ournotes-r2-prerender-content` 两服物化指针与 `/srv/ournotes-rendered/current{,-jp}` 已由当前 R2 预渲染任务生成。

## 最小部署

1. 将本目录 `export_r2_delivery_state.py` 单文件放到服务器 `/srv/ournotes-admin/export_r2_delivery_state.py`；将本目录的新 `.service` 和 `.timer` 放到 `/etc/systemd/system/`。只替换 `/srv/ournotes-admin/app/backend/admin/config.py`、`node.py`、`static/admin.mjs`，不覆盖整个应用目录。
2. 在现有 `/etc/ournotes-admin/node.json` 的目标 Global profile **仅新增** `"productionSource": "github-actions-r2"`。保留全部其他 profile、路径和凭据引用。这个标记让旧 schema 1 状态在过渡期间显示不可用，并禁用旧本机任务提交；其他 profile 的旧合同不变。
3. `systemctl stop ournotes-resource-state.path` 并 `systemctl disable ournotes-resource-state.path`，防止旧导出器覆盖新状态。`systemctl daemon-reload` 后先运行一次 `ournotes-r2-delivery-state.service`；检查新 `latest-run.json` 的 `schemaVersion=2`、`productionOwner=github-actions-r2`，以及两服 `delivery.regions`。若状态不可用，先查本机指针和渲染记录，不要复用旧 passed 文件。
4. 重启 `ournotes-node-api.service` 和 `ournotes-admin.service` 载入三个更新文件；检查管理页显示 Actions 生产链接及两服本机内容/HTML 身份，旧任务只显示为历史记录。随后 enable/start 新 timer。这里没有 GitHub 或 R2 写凭据，也不启用管理页写权限。

新导出器每两分钟只读取两个本地 pointer、对应 manifest/物化回执、两个 HTML `complete.json` 和 symlink。它比较身份，不重算数千媒体文件的 SHA；完整文件校验由 R2 物化任务负责。异常会以原子写入的 `unavailable` 取代旧成功结论；管理节点也会将超过六分钟或明显来自未来的采样判为不可用，避免 timer 停止后永远显示旧 `ready`。

## 回退

停止并禁用新 timer，恢复备份的三个应用文件和目标 profile 配置，再启用原 `ournotes-resource-state.path`，重启 node/admin 服务。旧导出器只代表本机旧更新器；回退时若旧 Global timer 仍已停用，管理页历史数据不会追新，不应标作当前 R2 生产。
