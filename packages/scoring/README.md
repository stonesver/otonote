# 共享计分

此目录是计分算法和公开排行计算的实现来源。纯模块不依赖网站目录、DOM、部署配置或网络；输入的规则、谱面和编成由调用方提供。服务器仍在内容更新时生成公共派生数据，浏览器和 Web Worker 仍计算个人配队，不新增计算 API。

- `scoring-engine.mjs`、`scoring-rules/*.mjs`：稳定快照、编成、谱面重建、普通及激奏计分和回放。
- `song-ranking*.mjs`、`song-skill-windows.mjs`：显式输入的排行计算和排序。
- `server/song-ranking-data.mjs`：仅 Node 可用的文件读取、校验及缓存适配器。调用方必须传入 `publicRoot` 和 `cacheRoot`；默认按此包的实际源码计算缓存指纹。
- `data/`：已审计的公开规则及 native 审计元数据基线，不是运行配置或账号资料。内容生产将当前 Master 参数绑定为版本化规则产物。`tools/build_formal_scoring_rules.py` 同步生成基线和旧网站 JSON 投影。

网站原 `site/src/lib` 路径保留薄转发入口，便于逐步迁移调用方。区服上下文、分享 URL 和页面代码留在网站层。Node 专用入口不能由浏览器导入。

算法版本由 `scoring-rules/model-version.mjs` 声明；规则文件另有 `ruleSetVersion` 和 `sourceReleaseId`。内容清单和排行缓存指纹覆盖实际共享实现。目录迁移没有改变算法版本或数值行为。

离线边界验证：`node --test site/tests/shared-scoring-package.test.mjs`。现有计分、原生回放和 Worker 测试继续通过网站兼容入口验证同一份实现。

## 发挥与养成场景

`performance-scenarios.mjs` 规范化有版本的原始操作条件；`performance-scenario-calculator.mjs` 将同一批样本用于普通或激奏。玩家样本、技能顺序、LUCK 随机和对手条件分别记录。明确判定不能反推出原始时机；参考输入不等于实机回放。

`formal-performance-state.mjs` 是普通技能生命条件、消耗与转换的共用状态。激奏任务、普通连击和结算保持各自语义，COMBO 排名使用最大任务连击。活动适配器在同一演出流程中作用于其确认环节，奖励换算仍独立。证据及边界见[机制审计](../../docs/plans/2026-10-04-performance-mechanism-evidence.md)。

`growth-scenarios.mjs` 解析持有、实际、参考与目标养成，先生成满足培养数量的变体，再交给候选搜索。保存目标不会写入个人实际卡库。搜索、Worker 和展示仍在网站层，核心模块不依赖 DOM 或个人存储。

新增离线场景验证：`node --test site/tests/performance-scenarios.test.mjs site/tests/growth-scenarios.test.mjs site/tests/team-planning-integration.test.mjs`。数据基线和算法版本分开绑定，更新情景或规则必须重算。
