# 演出情景与激奏机制：实现依据

日期：2026-10-04。模型：`ournotes-native-score-v6`。

这份记录区分规则表、原生方法检查、代码测试与实机验证。本次没有连接游戏客户端，不把下面的计算称为实机完整复现。

## 公共输入

`performance-scenarios.mjs` 提供 `ideal`、`steady`、`practice` 与 `explicit` 情景。前两种参考发挥和练习情景均公开具体偏差、漏击概率与种子；它们没有经过个人水平校准。生成器只依赖谱面和情景，不依赖队伍。

- `ournotes-performance-v1`：完整的明确判定、输入帧及技能顺序。判定不反推原始时机，不能用来衡量扩窗收益。
- `ournotes-performance-timing-v1`：完整的原始偏差、漏击标记和输入帧。先按规则表得到判定，再应用各队窗口与转换。
- 两者校验谱面哈希、全事件覆盖、输入顺序、帧率、显式时钟与版本。旧 AP 接口保持原来的默认情景。

`performance-scenario-calculator.mjs` 是推荐器的共用入口。固定玩家样本，分别遍历技能顺序及游戏随机；输出样本哈希、分布、段落指标和最好／最差样本回放。最低／最高分是本次抽样边界，不是理论极值。混合玩家波动后不沿用单个 LUCK 样本的标准误。

## 规则与证据

| 内容 | 依据与验证 | 边界 |
| --- | --- | --- |
| 判定窗口、损血与得分百分比 | `LiveJudgementTiming`、`LiveJudgementParameter`；合成谱面逐一测试 GREAT／GOOD／BAD／MISS | 未重建触屏命中、长条按压及自动子音符调度。时机情景属于规则表参考模型 |
| 普通连击、生命、迟到输入 | 复用既有 `createComboReplay`、`createLifeReplay`；原生方法样本 `formal-performance-state-native.json`；新测试比较普通与激奏的迟到输入 | 不把普通 FC 标签推定为 JUST 水平 |
| 普通技能生命周期 | 将既有恢复、生命条件得分、转换激活／过期提取为 `createOrdinarySkillLifecycle`；两种模式共同调用；原测试全部保留 | 同帧输入先执行，恢复先于生命条件得分检查，旧转换在过期帧的输入中仍参与 |
| 激奏动态生命条件 | 运行时读共享生命；高低生命分支测试 | 未测实机所有混合技能排列 |
| 激奏扩窗 4004 | 原有 float32 百分比窗口逻辑，原始操作情景测试激活前后变化 | 明确判定文件保留原判定，不凭空增加 JUST |
| 激奏转换 12006／13005 | 使用 Master 的实际目标判定与次数；仅成功转换消耗；13005 的正式目标包含 PERFECT 到 MISS | 普通转换先于激奏转换的混合排序仍需实机对照；不从技能文案推导排序 |
| COMBO 断连与保护 12004 | build 25 `GekisouController.RecalculateBonusDependentCounts` 0x55d66b8：0x55d6d20..0x55d6d54 使 3..6 增加任务连击并更新最大值；0x55d6e7c..0x55d6e88 使未保护的 1/2 重置当前值、保留最大值。0x55d6e08..0x55d6e60 消耗所有匹配保护项 | 保护只保留任务连击，失误不增加任务连击，也不修复普通连击和生命。排名取值继续按后续原生检查确认 |
| LUCK／JUST／任务加成／结算 | 保留现有原生时间、抽奖、排名奖励与延迟确认实现；非 AP 判定进入 LUCK 基础点数和 PERFECT 数统计 | 对手是输入情景，不提供无依据的个人胜率 |

非 AP 的 `ordinaryReferenceScore` 当前表示保留该次有效判定、移除激奏得分倍率的参考值，结果以 `referenceKind` 明确标记。它不是另一次自由演出的独立模拟，也不是单卡贡献；换卡应比较整队结果。

## 回归与复算

自包含测试：

```sh
node --test site/tests/performance-scenarios.test.mjs
```

该文件只读取仓库规则表，合成短谱面，不依赖私有音乐资源。覆盖：固定种子、难段局部改变、窗口判定、原始／有效判定分离、完整性校验、动态生命条件、恢复顺序、转换次数、迟到输入、COMBO 保护、分布聚合与配队间玩家样本一致。

已发布谱面另用原有 `formal-performance-replay`、`gekisou-just-boundary`、`gekisou-song-score`、`gekisou-score-settlement` 测试作兼容验证。资源目录只读，不写回正式资源。

推荐器筛选使用 10 个平衡顺序，最终计算保留 120 个顺序；玩家样本上限 16，默认 3。样本生成不随候选变化；较大的候选集需要分阶段筛选，不能在 UI 主线程无限展开。
