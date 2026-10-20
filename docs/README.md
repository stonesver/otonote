# 文档索引

文档维护当前说明和操作方法，改动历史查 Git／PR。`current` 表示当前维护入口，不表示功能已部署或通过实机验收。新增、更新与删除规则见[文档维护](governance/documentation.md)，未关闭问题集中在[待办](BACKLOG.md)。

按任务阅读：使用网站从使用指南开始；开发先看技术概览与开发手册；部署先看部署入口和对应组件手册；运维先看容量、内容管线或榜单手册。配置和服务模板保留在原目录，文档整理不移动或删除它们。

## 项目与用户入口

| Document | Role | Status |
| --- | --- | --- |
| [参与 OtoNote](../CONTRIBUTING.md) | `entry` | `current` |
| [OtoNote](../README.md) | `entry` | `current` |
| [OtoNote 技术概览](TECHNICAL_OVERVIEW.md) | `entry` | `current` |
| [OtoNote 使用指南](USER_GUIDE.md) | `entry` | `current` |

## 维护与公开规则

| Document | Role | Status |
| --- | --- | --- |
| [Repository guidance](../AGENTS.md) | `governance` | `current` |
| [配置、脱敏与源码发布边界](governance/configuration.md) | `governance` | `current` |
| [文档维护规则](governance/documentation.md) | `governance` | `current` |
| [公开源码边界](governance/public-source.md) | `governance` | `current` |

## 模块与契约

| Document | Role | Status |
| --- | --- | --- |
| [Golden Replay evidence intake](../catalog/baselines/scoring/README.md) | `reference` | `current` |
| [三服邮箱认证与账号读取](reference/account-reads.md) | `reference` | `current` |
| [计算搜索与证书边界](reference/calculation-search.md) | `reference` | `current` |
| [服装图鉴](reference/costumes.md) | `reference` | `current` |
| [抽卡记录](reference/gacha-history.md) | `reference` | `current` |
| [国际服公共维护状态](reference/game-service-status.md) | `reference` | `current` |
| [Global decoder binding on a verified client upgrade](reference/global-decoder.md) | `reference` | `current` |
| [沉浸式场景](reference/immersive.md) | `reference` | `current` |
| [JP 客户端自动升级](reference/jp-client-upgrade.md) | `reference` | `current` |
| [两服目录身份与版本差异](reference/library-identity.md) | `reference` | `current` |
| [演出情景与激奏机制：实现依据](reference/performance-scenarios.md) | `reference` | `current` |
| [私有状态 checkpoint 与恢复](reference/private-state.md) | `reference` | `current` |
| [浏览器截图导入](reference/screenshot-import.md) | `reference` | `current` |
| [公告与页面更新提示](reference/site-notices.md) | `reference` | `current` |
| [共享计分](../packages/scoring/README.md) | `reference` | `current` |
| [Our Notes 本地养成导出工具](../packaging/growth-tool/README.md) | `reference` | `current` |
| [浏览器截图识别原型](../tools/browser_card_import/README.md) | `reference` | `current` |

## 开发、部署和运维

| Document | Role | Status |
| --- | --- | --- |
| [私有管理页的内容发布流程](../deploy/admin/R2_DELIVERY.md) | `runbook` | `current` |
| [R2 预渲染部署与回滚](../deploy/r2-prerender.README.md) | `runbook` | `current` |
| [官方更新档案：本地使用与外置配置](../deploy/update-archive.README.md) | `runbook` | `current` |
| [部署入口](DEPLOYMENT.md) | `runbook` | `current` |
| [内容生产与 R2 交付](runbooks/content-pipeline.md) | `runbook` | `current` |
| [服装全身静态图](runbooks/costume-posters.md) | `runbook` | `current` |
| [开发、内容生产与发布](runbooks/development.md) | `runbook` | `current` |
| [可选外部更新触发器](runbooks/external-trigger.md) | `runbook` | `current` |
| [JP Version 接口出口](runbooks/jp-egress.md) | `runbook` | `current` |
| [BHK 登录诊断日志](runbooks/login-diagnostics.md) | `runbook` | `current` |
| [运行维护](runbooks/operations.md) | `runbook` | `current` |
| [玩家榜采集运行约定](runbooks/rankings.md) | `runbook` | `current` |

## 长期设计依据

| Document | Role | Status |
| --- | --- | --- |
| [挑战配队联合上界的正确性说明](decisions/challenge-search-bound.md) | `decision` | `current` |
| [收益加成约束下的记分上界证明](decisions/event-search-bound.md) | `decision` | `current` |

## 未结事项

| Document | Role | Status |
| --- | --- | --- |
| [未结事项](BACKLOG.md) | `backlog` | `current` |

## 许可与第三方材料

| Document | Role | Status |
| --- | --- | --- |
| [第三方项目、依赖与致谢](../THIRD_PARTY_NOTICES.md) | `legal` | `current` |
| [Symbol fallback](../backend/qqbot/fonts/README.md) | `legal` | `current` |
| [源码、开源许可与内容权利](LICENSING.md) | `legal` | `current` |
| [Live2D Cubism Core notice](../site/public/vendor/live2d/NOTICE.md) | `legal` | `current` |

实际环境位置、凭据、配置备份及必要恢复回执留在仓库外。发布摘要仅在不兼容变更或必要迁移时按需创建，不维护逐任务完成记录。
