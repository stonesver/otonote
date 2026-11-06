# 演出情景与激奏机制：实现依据

规则与模型版本以共享计分包声明为准；本文区分静态依据与实机证据。

规则表、原生方法检查、代码测试与实机验证分别成立。以下计算模型不构成实机完整复现的承诺。

舞台的属性／任务覆盖、固定队伍多曲评估、轮换有效期及 Global 1.1.0 新卡技能复用边界，统一见[激奏舞台规则与配队接入](arena-stage.md)。本文的既有激奏支持范围不自动表示舞台或新版全卡池已接入。

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
| 普通技能生命周期 | 恢复、生命条件得分、转换激活／过期、判定解除和累计加分统一使用 `createOrdinarySkillLifecycle`；两种模式共同调用；原测试全部保留 | 同帧输入先执行，恢复先于生命条件得分检查，旧转换在过期帧的输入中仍参与 |
| 激奏动态生命条件 | 运行时读共享生命；高低生命分支测试 | 未测实机所有混合技能排列 |
| 激奏扩窗 4004 | 原有 float32 百分比窗口逻辑，原始操作情景测试激活前后变化 | 明确判定文件保留原判定，不凭空增加 JUST |
| 激奏转换 12006／13005 | 使用 Master 的实际目标判定与次数；仅成功转换消耗；13005 的正式目标包含 PERFECT 到 MISS | 普通转换先于激奏转换的混合排序仍需实机对照；不从技能文案推导排序 |
| COMBO 断连与保护 12004 | build 25 `GekisouController.RecalculateBonusDependentCounts` 0x55d66b8：0x55d6d20..0x55d6d54 使 3..6 增加任务连击并更新最大值；0x55d6e7c..0x55d6e88 使未保护的 1/2 重置当前值、保留最大值。0x55d6e08..0x55d6e60 消耗所有匹配保护项 | 保护只保留任务连击，失误不增加任务连击，也不修复普通连击和生命。COMBO 排名使用最大任务连击，当前任务连击另行输出 |
| LUCK／JUST／任务加成／结算 | 保留现有原生时间、抽奖、排名奖励与延迟确认实现；非 AP 判定进入 LUCK 基础点数和 PERFECT 数统计 | 对手是输入情景，不提供无依据的个人胜率 |

普通技能还支持按 PERFECT／JUST 每 N 次增加倍率（2001），分别读取累计次数上限和效果值上限；激活帧也读取当前帧判定，更新时撤销旧句柄再添加新句柄，结束后撤销当前值。理想 AP 与非 AP、普通与激奏共用生命周期，AP 不直接套用最大倍率。判定解除条件（1020）在执行状态检查，采用本帧最后一个匹配音符的谱面时间；激活帧及紧接的 ExecuteFrame 不检查解除。开局静态乐队条件、执行上限为一次的 BAD／MISS 到 GOOD 转换按成功转换消耗，次数耗尽后不随成员技能重新发动。尚未支持的执行重置条件仍明确拒绝。

这些新增普通机制检查了 1.1.0 原生方法：`SkillEffectUpdater` 的 Stay／ExecuteFrame／Executing、`SkillConditionNoteJudgementEqualChecker`、`NoteCumulativeScoreUpApplier` 和 `TargetJudgementConvertApplier`。`analysis/crypto/verify_current_ordinary_skills_native.py` 用显式私有路径和固定二进制摘要重放队长人数累计、上限、分量累计与判定除法的 ARM64 指令；合成样本保存在 `current-ordinary-native.json`。泛型集合、接口分派及属性匹配谓词由夹具替代，不能当作 Unity 调度或整场实机验收；当前整场模型仍保留参考兼容标记。

非 AP 的 `ordinaryReferenceScore` 当前表示保留该次有效判定、移除激奏得分倍率的参考值，结果以 `referenceKind` 明确标记。它不是另一次自由演出的独立模拟，也不是单卡贡献；换卡应比较整队结果。

COMBO 排名发送链已核对：`MultiLiveStatePlayingStateNode.OnTryConnectGekisouResult` 0x613c948 在 0x613cc8c..0x613ccb0 读取 `IReadOnlyGekisouRangeState` 槽 12（`get_MaxCombo`），经 0x613ccc8 保存并在 0x613cec8 送入结果的 Combo 字段，0x613cefc 发送；`CompareCombo` 0x60aaf6c 比较该结果字段。输出的 `sections.combo` 因而表示排名用最大值，`currentCombo` 表示段末当前值，`maxCombo` 明确保留最大值。

新增 `gekisou-combo-native.json` 保存 48 个原始 ARM64 指令块执行结果，覆盖 BAD／MISS 重置、GOOD 至 JUST 累加、多个有限保护同时消耗，以及有限保护与无限保护共存。执行范围仅为上述判定指令块，泛型 List 存取／删除由测试夹具替代，不能当作整段状态机或实机验收。保护撤销命令与音符同刻时先执行，因此区间结束为排他边界。

## 三处文案与执行口径

本节依据仓库的 `global-1.0.1-25-code-v6` 规则快照与现存卡片文案快照。后者来自不同时间的目录快照，不能推定为同版客户端原文。模型如何记录证据及限制消费方，见[技能语义模型与执行契约](skill-semantics.md)；其中的新支持判定尚未接入现有程序。

| 代表技能（Lv.5） | 数据与当前执行口径 | 已复现的区分案例 | 证据结论 |
| --- | --- | --- | --- |
| 「GREAT IDEA!!!!!」，激奏留影技能 76 | 文案写下一次 PERFECT；效果行 755／760 的目标为 PERFECT 至 MISS。仅成功转换消耗额度 | MyGO 成员累计 30 次 PERFECT 后，五种目标分别都可转为 JUST；原本 JUST 不消耗待用次数 | 数据与实现一致，文案描述范围较窄；不以文案缩小执行选择器 |
| 「雨过天晴，指动琴鸣」，激奏技能 13 | 文案写 COMBO 保持在 25 以上。效果行 65 使用条件 7005、触发类型 2、无显式解除；当前运行时达标后保留 +5 | 25 次 PERFECT 后 MISS 清零，下一次 PERFECT 获得 6 点任务 COMBO | 当前实现存在已确认偏差：同版原生持续型更新器在门槛不满足时撤销，重新满足时重新安装；详见下节原生验证 |
| 「想留下的诗歌，真诚地传达给你」，激奏技能 16 | 效果行 80／85 在 JUST 区段进入时按 LIFE 选额外 +1／+3；≥700 选高分支，之后不切换 | 进入时 699、首个 JUST 时 700 仍 +1；反向仍 +3。进入时 700、之后降到 600，首个 JUST 总计 4；若伤害发生在进入帧、技能阶段前，则选低分支，总计 2 | 数据与实现支持进入帧技能阶段读取 LIFE；“第 1 次 JUST 开始”可解释为首次收益，不必解释为发动事件 |

执行位置分别为 [转换操作](../../packages/scoring/scoring-rules/gekisou-effect-operators.mjs)、[条件程序](../../packages/scoring/scoring-rules/skill-condition-program.mjs)、[生命周期](../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs)与[逐帧阶段](../../packages/scoring/scoring-rules/gekisou-frame-replay.mjs)。触发类型 2 当前仅对含 RUSH 的激活分支执行持续条件失效检查；对技能 13 的零持续时间 COMBO 门槛组合，这与下述原生证据不一致。同一遗漏涉及技能 12、18、19，范围见[全量影响核查](#持续条件遗漏全量影响核查)。

上述当前 JavaScript 行为的 11 组边界复现使用临时离线探针，未纳入仓库测试；COMBO 生命周期另有下述持久原生验证。既有 `gekisou-skill-composition` 与 `performance-scenarios` 两套自包含测试共 30 项通过，提供通用转换、门槛与生命分支覆盖，不能等同于这三个具体差异的客户端证明。另两套旧测试 `gekisou-just-boundary`、`gekisou-song-score` 因引用的 `site/src/data/formal-scoring-rules.json` 缺失未能启动。持久回归与证据补齐见[待办](../BACKLOG.md)。

### COMBO 门槛：同版原生生命周期验证

build 25 的静态映射与原生执行确认：技能 13 达标时获得 +5，检查到当前任务 COMBO 跌破 25 时撤销，再次达标重新获得一份 +5。持续满足不会逐帧叠加，断连也不保留加成。

| 环节 | 原生依据 |
| --- | --- |
| 条件映射 | `CreateGekisouChecker` 的 7005 跳转到 `0x55f5760`，构造 `GekisouComboCountGreaterEqualChecker` |
| 读取与比较 | `Check`（`0x55ed6a0`）读取 `IReadOnlyGekisouRangeState` 槽 11 `get_Combo`，比较 ≥ 门槛；槽 12 才是最大 COMBO |
| 持续型路由 | `ConditionSkillUpdater` 在 `0x561c600..0x561c7a0` 按触发类型 2 构造 `SustainedSupportSkillEffectUpdater`；零持续时间进入 `NonActivationTimeSkillEffectUpdate`（`0x5620c4c`） |
| 条件失效 | `0x5621028..0x5621100` 对已安装效果以 `forceEnd=1` 调用底层更新器；效果进入 EndFrame，`GekisouComboBonusUpApplier.Update`（`0x55ff1e0`）发出撤销命令 |
| 再次满足 | 旧 EndFrame 在下一次更新先清理并归还池；本次条件为真且资格通过时，再取出执行器重新发动。同一更新可完成清理及重入；已有活动效果时不重复取出 |

[离线验证脚本](../../analysis/crypto/verify_gekisou_combo_threshold_native.py)校验原始与解码库 SHA，并校验规则行 65 的组合；[合成结果](../../site/tests/fixtures/gekisou-combo-threshold-native.json)保留 15 次状态更新、四次发动／撤销及池操作。原始客户端和反汇编材料不进入仓库。

验证连续执行原生条件检查、触发结果构造、持续型更新、底层状态转换和加成操作器。替代项为 IL2CPP 元数据与接口分派、输入状态／时钟 getter、已知效果参数、单元素对象池、字典存储、变更通知和命令接收器；比较、是否结束、是否重入、是否添加／撤销由原始指令决定。外层构造路由由静态分析确认，未执行整个 Unity 调度器、全技能池或整曲计分。

代表序列为 `24 → 25 → 30 → 0 → 0 → 24 → 25 → 30 → 24 → 25`：第一次达标添加 +5，保持满足不重复添加，0／24 撤销；再次 25 恢复 +5。结束后的下一更新即重新达标时，也能先清理后恢复。安装命令使用最后一次 COMBO 判定时间；撤销命令使用当前更新时刻。该验证不能把条件检查时刻等同于原始 MISS 输入时刻。

同样的合成 COMBO 序列喂给当前运行时，15 次更新有 7 次加成状态不一致：原生已撤销，运行时仍保留 +5。现有执行器不在本次修订范围，已知不一致的支持限制见[消费方契约](skill-semantics.md#combo-差异对消费方的影响)。直接原生回放限定于已校验的单 COMBO 门槛、零持续时间、无额外资格／解除、无次数上限组合；同一执行路径的其他命中及组合依据见下节，带时长和有限预算的其他技能不能直接外推。

在提供本地私有输入的环境复跑：

```sh
PYTHONPATH=analysis python3 analysis/crypto/verify_gekisou_combo_threshold_native.py \
  --client /private/client/libil2cpp.so \
  --decoded /private/client/libil2cpp.decoded.so \
  --output /tmp/gekisou-combo-threshold-native.json
```

### 持续条件遗漏：全量影响核查

核查覆盖正式规则五类效果表全部 1800 行及较新 `global-1.1.0-86` Master 的全部 3700 行，展开触发／资格／解除／预算重置条件。全部 7005 引用均为激奏成员技能 12、13、18、19 的触发条件，共 30 行。四组均走类型 2、零持续时间路径，18／19 另将 LIFE 正反条件与 COMBO ≥1 组成 AND。较新 Master 的命中效果及条件闭包与正式快照相同，成员引用从 6 条增至 9 条；发布范围与新版客户端行为未因此得到验证。完整卡片清单、等级和适配要求统一维护在[执行契约](skill-semantics.md#全量核查与受影响范围)。

组合依据：build 25 `SkillConditionCheckerFactory.CreateAndChecker`（`0x55f3de0`）逐条构造检查器，在 `0x55f4148..0x55f4154` 以组合类型 1 构造 `SkillConditionCheckers`。其 `Check`（`0x55f61b0`）在 `0x55f62ec..0x55f62f0` 对任一子条件为假的 AND 返回失败；`0x55f62c4..0x55f62d4` 聚合的是子检查器的命中数最大值，供 `SkillExecuteTriggerResult.HitCount` 使用，不是时间戳。结合持续型路由，不能将 LIFE 仅当首次资格、或将其中的 COMBO 条件视为一次性达标。双效果原生验证见下节。

[只读全量核查脚本](../../scripts/audit_gekisou_sustained_conditions.mjs)枚举五表及全部类型 2，并直接调用未改动的正式编译器／执行器，覆盖 4 技能的 Lv.1–5；18／19 分别探测 LIFE 下跨、上跨和 COMBO 清零，共 40 组，40 组均有契约状态差异。技能 12 无成员引用，使用临时绑定加载真实效果行。脚本中的期望值是契约状态目标，不是独立原生输出，也未计算整曲分差。

```sh
# 正式快照：全量枚举与当前执行器复现
node scripts/audit_gekisou_sustained_conditions.mjs
# 可选私有 Master：同时核对效果与条件闭包，以及新增卡片引用
node scripts/audit_gekisou_sustained_conditions.mjs /private/master
```

输出的 `casesWithMismatch` 表示已知缺陷仍可复现，不是测试通过数。适配后应将下述原生命令预期接入正式运行时回归，并补重复来源和完整计数回算。原生代表案例与全量 40 组契约探针是不同证据，不合并成“全部客户端验证通过”。

### LIFE 与 COMBO 复合条件原生验证

build 25 的 18／19 两档是 `COMBO ≥1 AND LIFE ≥门槛` 与 `COMBO ≥1 AND NOT(LIFE ≥门槛)`。每级门槛取对应 Master，低档不是独立基础加成再叠高档。以下静态链限定到当前审核的客户端二进制：

| 环节 | 已核对依据 |
| --- | --- |
| LIFE 与取反 | `SkillConditionLifeCheckerBase.Check`（`0x55f10e4`）每次调用 LIFE getter；`LifeGreaterEqualChecker.Check`（`0x55f1428`）比较当前值与参数；`CreateChecker` 在 `0x55f4680..0x55f46b0` 为负条件套 `SkillConditionNotChecker`，其 `Check` 为 `0x55f653c` |
| 根检查器的时间策略 | metadata 中 `SkillConditionCheckers` 定义构造、Check、Reset，没有覆盖时间 getter。使用 `ISkillConditionChecker.get_IsOverrideTimeMs`（`0x55f1084`）默认 false；`ConditionSkillExecuteTrigger.Update` 在 `0x561b514..0x561b5d8` 选择当前输入时间或根检查器覆盖时间。子 COMBO 的覆盖时间不自动向 AND 传播 |
| 命中数与时间分离 | COMBO 达标在 `0x55ed878` 写出命中数 1；LIFE 比较在 `0x55f14d8` 写出比较结果。触发器将此值保存在结果第三字段；`get_HitCount` 为 `0x561b8a8`，时间另由 `get_TimeMs`（`0x561b8a0`）读取 |
| 检查与效果批次 | `ConditionSkillUpdater.Update` 的 `0x561d924..0x561d988` 先缓存各触发结果；`0x561d9b4..0x561dcfc` 再按效果序列处理持续更新并收集变化状态。当前组内只有计数加成，无 LIFE 改写副作用 |
| 命令顺序 | `SkillFrameResult.AddCurrentFrameUpdateSkillEffectState`（`0x55fe950`）调用追加容器（`0x926dd24`），不按结束／发动排序。`SkillApplierController.Update` 的 `0x560db1c..0x560dd48` 按结果序列逐项调用应用器 |
| 外层阶段 | `LivePlayingStateNodeBase.Update` 在 `0x612b3b4` 调用普通演出更新，在 `0x612b5ec` 更新技能阶段、`0x612b624` 应用其命令，至 `0x612b888` 才调用 `OnUpdateGekisou`，后者在 `0x612c1e4` 调用任务更新。`GetCurrentLife`（`0x612ea80`）使用当前技能时刻调用 `LiveExecutor.GetLifeAtMs` |

[双效果离线脚本](../../analysis/crypto/verify_gekisou_life_combo_native.py)校验同版二进制摘要及实际效果／条件行。[合成原生结果](../../site/tests/fixtures/gekisou-life-combo-native.json)覆盖两个技能、五个等级、低→高及高→低两种遍历顺序，每组 15 次更新，共 300 次。断言包括：两个复合触发结果、命中数、生命周期阶段、完成后的活动加成、安装／撤销动作顺序与时刻。覆盖 LIFE 等于门槛、上下跨档、跨档与 COMBO 清零／恢复同时可见、连续满足及紧接结束后的重入，全部通过。

输入刻意将最后判定时刻设为当前更新前 40 ms。原生 18／19 的所有安装与撤销均发生在当前更新时刻；连续为真不再次发动。低档行在前时，高→低发出“加低、撤高”，低→高发出“撤低、加高”；反序输入交换命令次序，最终加成仍一致。因此不能把“更新后只留一档”解释为“客户端必定全局先撤销再安装”。

替代范围为 IL2CPP 元数据／接口绑定／对象构造、LIFE／任务 COMBO／时钟 getter、数组视图、每效果单元素池、变化状态收集、句柄字典及命令接收器。外层“先缓存触发、再更新效果”的调用由夹具按静态链调度，并测试两种给定遍历顺序；比较、取反、AND、触发时刻选择、持续状态转换、应用器遍历和添加／撤销决策执行原始指令。此回放不模拟真实音符输入、完整主循环、全技能池、保护／恢复混合及整曲分数；“同批判定先断连再恢复是否被检查到”按上述静态阶段解释。

```sh
PYTHONPATH=analysis python3 analysis/crypto/verify_gekisou_life_combo_native.py \
  --client /private/client/libil2cpp.so \
  --decoded /private/client/libil2cpp.decoded.so \
  --output /tmp/gekisou-life-combo-native.json
```

当前 JavaScript 的 `compileSkillConditions.timestamp` 仍对含 7005 的 AND 使用最后判定时间；两张代表卡的首次发动探针均输出 980 ms，而同输入的原生结果为 1020 ms。该时点差异与持续条件残留分别进入[执行契约](skill-semantics.md#技能-1819复合条件与同帧换档)，即使没有断连／跨档也不能只凭状态值一致宣布分数不受影响。

## 已发布激奏效果清单

本表记录当前规则版本的处理方式，类型覆盖不等于所有卡片组合都已实机验证。数值、目标与等级均从对应 Master 行读取，不在推荐器中另设权重。

| 类型 | 局内处理 | 主要边界 |
| --- | --- | --- |
| 12000 | 增加任务 COMBO 每次成功判定的计数 | 进入段落或达到阈值后生效；历史命令按时间重算；持续结束时撤销加成 |
| 13000 | 增加 JUST 任务计数 | 仅实际有效 JUST 累加；不改变非 JUST 判定 |
| 13002 | 按累计 JUST 达到门槛增加后续计数 | 累计门槛与上限分别读取，不把累计计数直接当音符分数 |
| 11001 | 调整 LUCK 音符提供的基础点数 | GOOD／GREAT／PERFECT 使用各自规则；BAD／MISS 不提供点数 |
| 11002 | RUSH 抽奖结果追加任务点数 | 点数用于排名，不能直接充当音符得分倍率 |
| 11003 | 进入段落或指定抽奖结果后增加槽量 | 读取发动次数上限；空帧处理积压抽奖 |
| 11005 | 指定次数的抽奖结果保底 | 复用已预取结果和多个保底项的原有消耗顺序 |
| 2000 | RUSH 条件下普通加分倍率 | 与 RUSH 自带乘区分开；动态生命条件检查后更新 |
| 2001 | COMBO／JUST 累积得分倍率 | 读取累计条件和上限；更新时撤销旧值再加新值 |
| 4004 | 按原始 JUST 窗口百分比扩窗 | 浮点处理与取整沿用旧实现；效果从后续输入帧可见 |
| 12006 | 将指定判定转换为 PERFECT | 按目标判定消耗次数，段落进入后的后续输入生效 |
| 13005 | 达到 PERFECT 间隔后储存 JUST 转换次数 | 正式目标包括 PERFECT 至 MISS；成功转化才消耗；同一输入只消耗一个成功转换来源 |
| 12004 | 保护任务 COMBO 不因指定判定重置 | 现有目标仅 MISS；不修复普通连击／生命；所有匹配保护项消耗次数 |

`3004` 生命伤害减轻按实际生命损失应用。同源刷新、跨来源叠加和生命条件得分联动由组合测试覆盖；具体卡片、等级和持续时间来自版本化规则，不在本文固定为某张卡的历史参数。

内容发布通过 `inspectPublishedSkillsCompatibility` 输出实际公开卡片各等级的诊断报告，不因计算器覆盖不全阻断资料发布。激奏条件与效果由独立程序组合，统一处理持续、释放、执行次数和重置；歌曲无关任务在解析技能细节前排除。相关缺失机制仅排除受影响配对并说明覆盖限制，真正的数据或程序错误仍明确结束为失败。组合执行接口见[共享计分包](../../packages/scoring/README.md)。

所有正式留影激奏技能的非 AP 入口均由自包含测试遍历。技能未触发不等于技能无用：生命条件、配对、区段类型、判定位置和剩余次数都保留在条件或回放数据中。仍未完成实机对照的组合排序列在前表，不隐藏为“已验证”。

## 回归与复算

自包含测试：

```sh
node --test site/tests/performance-scenarios.test.mjs
```

该文件只读取仓库规则表，合成短谱面，不依赖私有音乐资源。覆盖：固定种子、难段局部改变、窗口判定、原始／有效判定分离、完整性校验、动态生命条件、恢复顺序、转换次数、迟到输入、COMBO 保护、分布聚合与配队间玩家样本一致。

已发布谱面另用原有 `formal-performance-replay`、`gekisou-just-boundary`、`gekisou-song-score`、`gekisou-score-settlement` 测试作兼容验证。资源目录只读，不写回正式资源。

推荐器筛选使用 10 个平衡顺序，最终计算保留 120 个顺序；玩家样本上限 16，默认 3。样本生成不随候选变化；较大的候选集需要分阶段筛选，不能在 UI 主线程无限展开。
