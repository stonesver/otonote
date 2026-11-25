# R2 预渲染部署与回滚

预渲染只物化渲染所需的公开内容子集，媒体由 R2 网关提供。物化缓存、代码版本和 HTML 目录分别管理；旧本机完整内容生产管线已退役，不作为本流程回退目标。整体链路见[内容管线](../docs/runbooks/content-pipeline.md)。服务模板不代表实际启用状态。

## 准备

1. 在已审阅的干净默认分支运行 **Publish R2 prerender image**，核对源码 revision、离线运行检查和不可变镜像摘要。使用配套 wrapper 与镜像，不能用新 wrapper 搭配不支持其参数的旧镜像。
2. 将固定镜像身份写入外置配置。无 registry 拉取条件时，可验证工作流提供的 Docker 归档 SHA-256 后流式导入，使用 summary 的 `sha256:<image ID>`；保留 registry digest 作为来源，不在服务器现场重新构建。
3. 外置环境使用 `deploy/r2-prerender.env.example` 核对字段，保留实际路径与权限。服务器仅授予公开内容桶 read/list 权限，不能挂载私有生产状态桶或复用 Actions 写入密钥。
4. 检查镜像下载／展开、双服物化、暂存 HTML 和临时输出的同盘叠加预算，留出余量。按实际环境设置空间门槛，不引用旧报告里的剩余容量。
5. 等待当前任务退出，备份 wrapper、service、私有配置和镜像身份；确认旧触发器不会并发写入，保留当前服务与所有持久数据。

封存代码包已包含预渲染脚本，无需在服务器安装 Astro 或网站 node_modules。wrapper 验证镜像源码标签；渲染和晋级容器无网络。代码／HTML 的暂存和目标目录需满足原子重命名的文件系统条件。

## 执行与验收

先手动运行新 oneshot，再核对两服内容指针、物化回执及 staged HTML。物化回执绑定 manifest 和完整本地文件；无变化仍核验回执与字节。缺回执完整复验，损坏或软链接拒绝。

只有代码／内容组合变化或现有视图损坏时才进入新的暂存渲染。双服 complete.json、报告、必需页面与 payload 摘要通过后，移动不可变版本并切换两服链接。两条链接不是单次文件系统事务，切换失败恢复旧目标；暂存失败保留当前网页。

确认主要页面、媒体、版本身份和浏览器交互后启用对应 timer。服务 active 不代表内容新鲜；管理采样另见[交付状态](admin/R2_DELIVERY.md)。

## 回滚

停止对应新触发器并等待运行结束，恢复匹配的上一版 wrapper、镜像与必要配置。验证保留的旧代码／内容组合及其 R2 对象可用，然后通过受审发布入口恢复或重新生成旧 HTML。检查两服链接、complete.json、公开媒体和旧页面载荷后恢复该流程的 timer。

不要重新启用已退役的旧本机更新器，不因回滚撤销仍被页面依赖的 Worker Route。回滚不删除已发布内容、私有输入或历史 payload；缓存和 HTML 回收另按[运维手册](../docs/runbooks/operations.md)执行。

## 双服静态交付到 Workers

`Deliver approved static site` 从默认分支的成功 push CI 读取代码候选、独立回执摘要和两个已晋级的 R2 内容指针，以同一份已验收代码在 Actions 上生成两服页面。代码包及各区域按版本保存的渲染产物位于私有桶的 `web-delivery/v1/`。界面代码和页面数据随 Worker 版本交付，同时带上上次成功发布版本的不可变资源。实时榜单入口使用客户端入口页，查询继续访问原有 API。

1. 在源站安装 `export-static-code.py` 和同目录的 `ournotes-static-code.service`、`ournotes-static-code.path`。启用 path 单元并首次运行 service。在站点 HTTPS 配置内引入 `static-code-input.location.conf`，检查 nginx 配置后平滑加载。该入口 `/_site-delivery/code.json` 提供源站同步所需的当前版本。
2. 在仓库配置 `STATIC_SITE_ORIGIN`（正式 HTTPS 源，不带末尾斜线）、`STATIC_WORKER_NAME`、`STATIC_WORKER_URL`（该专用 Worker 的 HTTPS 地址）。在已有内容交付环境中添加 Workers Scripts 编辑令牌 `CLOUDFLARE_API_TOKEN`。区域路由由站点管理人在面板维护。
3. 首次在默认分支手动运行工作流，勾选 `bootstrap`，目标必须是未使用过的 Worker 名称。如果已有成功的双服预渲染试跑，可分别填写 `current_trial`、`previous_trial`，分别复用当前视图和保留上一版不可变资源。工作流会比对当前试跑与两服已批准指针。若内容已更新，留空 `current_trial` 重新渲染。首次运行只创建独立的 workers.dev 站点。
4. 工作流成功后设置仓库变量 `STATIC_SITE_ENABLED=true`，在该 Worker 绑定正式主机的五种路径 `/global/*`、`/jp/*`、`/app/releases/*`、`/rendered/releases/*`、`/site-status/*`。域名须为代理状态。在正式主机检查两服中英文首页、工具页、榜单页、状态 JSON、旧脚本和一个榜单 API。静态响应带有 `X-OurNotes-Delivery: static-assets`。根路径与旧链接继续由 nginx 跳转，内容网关及后台路径保持原路由。

默认分支的 push CI 成功后，交付任务从同一次运行取得候选包和 `static-code-approval`，固定提交和回执摘要。上传前和激活前分别检查分支头和两服内容指针。内容生产完成时复用上次上线代码，定时检查会补上最新提交的成功 CI。首次部署需有带独立回执的成功 CI。已有站点沿用私有桶的 `web-delivery/v1/live.json` 和已缓存代码。

Worker 候选和线上版本均通过网页检查后，工作流记录新的 `live.json`，完成发布。

需要同步源站时，从本机核对 Worker 的两服 `/site-status/{region}.json` 与成功 CI 的 `static-code-approval`，确认 `codeId` 一致。使用同次 CI 的代码包、回执摘要和源站当前代码 ID，按[源站发布步骤](../docs/runbooks/development.md#源站发布设置与执行)执行。源站预渲染 timer 完成后，直连源站核对代码回执、两服渲染组合和中英文首页。

紧急整站回源时，在面板移除上述五条静态路由，并将 `STATIC_SITE_ENABLED` 设为 `false`。切换前核对源站代码及 Global、JP 实际渲染链接与目标版本。只回退 Worker 版本时，在“部署”中选已验证版本回滚；同时暂停自动交付，确认源站和已批准输入后再恢复。
