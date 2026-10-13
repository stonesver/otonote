# Worker 指标接入私有告警

已实现可选的只读 Analytics 采样，复用已批准的两分钟本地 timer。每次只查询指定 Worker 的最近十分钟与 UTC 当日聚合，15 秒超时、64 KiB 响应上限、不跟随重定向。输出只包含白名单数值，不记录凭据或原始错误正文。

- 最近十分钟至少 5 次错误且错误率至少 1% 时告警。
- 只有显式配置运维日请求预算后，达到预算 80% 才告警；不把采样执行量当作账单或套餐额度。
- 查询失败或数据超过六分钟失效，持续十分钟后告警。未配置凭据明确显示“未配置”，不显示零请求作为健康证据。
- 状态打开、恢复只记录一次；私有 API 和页面只显示固定字段。

本地行为测试覆盖失败、非法数值、矛盾计数、告警去重、恢复和失效；现有本机认证的真实只读查询已验证。用户已明确暂缓 Analytics 专用凭据，服务器保持未配置状态，因此持续指标采样尚未启用。

需单独批准后配置：现有 Cloudflare 账号范围的 `Account Analytics: Read` 专用凭据，保存于服务器 root-only 的 `/etc/ournotes/cloudflare-analytics.env`，键为 `CF_ANALYTICS_READ_TOKEN`。不复制本机 OAuth，不授权 Worker 修改或 R2 写入。可选 `CF_WORKER_DAILY_REQUEST_BUDGET` 是人工设定的运维预算，默认 0 表示未设置。此凭据与已暂缓的 GitHub Token、外部生产触发器无关。

回退：恢复采样 wrapper、unit、私有页面及 reader 的部署备份，删除新增环境文件的引用并 daemon-reload；现有更新、交付、榜单和磁盘采样继续工作。

依据：[Cloudflare Analytics 凭据权限](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)、[Worker 指标查询](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)。
