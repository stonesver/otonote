# 部署入口

正式代码发布使用 `scripts/publish-web-client.sh`，晋级同一已验收产物，不重新构建。候选、外置配置、固定回执摘要、旧版本检查与失败回滚见[开发与交付手册](runbooks/development.md)。真实配置以现场受保护文件为准，不要用模板覆盖，参见[配置边界](governance/configuration.md)。

| 对象 | 操作说明 |
| --- | --- |
| 网页代码和不可变程序包 | [开发与交付](runbooks/development.md) |
| Global／JP 内容生产、R2 与调度 | [内容管线](runbooks/content-pipeline.md) |
| 内容物化与 HTML 交付 | [预渲染](../deploy/r2-prerender.README.md) |
| 私有管理页交付状态 | [管理页](../deploy/admin/R2_DELIVERY.md) |
| 玩家榜采集与最终归档 | [榜单运维](runbooks/rankings.md) |
| 官方更新档案 | [归档配置与启用](../deploy/update-archive.README.md) |
| 空间维护与恢复 | [运行维护](runbooks/operations.md) |

代码、内容、程序和持久状态分别记录身份与恢复目标。部署前核对当前版本和私有备份，部署后分别验收 HTTP 健康、预渲染组合、CDN、主要页面与浏览器交互。具体部署回执放入有保留条件的私有环境资料，不追加到本页。文档修改不会启用服务、触发发布或授权数据清理。

## Query 独立启用条件

Query 使用安装后的 `query.service` 单元及容器 UID/GID 10001。完成容量、配置、权限验收并获准启用后，身份目录可用 `install -d -o 10001 -g 10001 /srv/ournotes-data/identity` 准备，再执行 `systemctl start query.service`。新 Query 与公网路由不随其他组件发布自动启用。目录是服务契约示例；执行前核对实际挂载，保留已有数据。
