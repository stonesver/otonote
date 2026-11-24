# 前端视觉基座、组件规范与素材使用准则

本文规定 OtoNote 前端的共享视觉语言、标准控件原语、工作台结构、图标与游戏素材使用边界，以及 CSS 级联与验收约定。新增页面或重构既有功能时以本文为准，保持全站交互与排版一致性。

## 1. 视觉体系、三层表面与主题语义

网站采用“精炼纸感编辑风 + 多主题柔和着色壳层”。整站保留 [theme-presets.mjs](../../site/src/lib/theme-presets.mjs) 提供的 18 套主题预设（含 `night` 深色预设、5 套乐队代表色与 5 套活动属性配色，均满足 WCAG AA ≥ 4.5:1 对比度）；所有共享 UI 颜色通过 [theme-tokens.css](../../site/src/styles/theme-tokens.css) 与 [design-foundation.css](../../site/src/styles/design-foundation.css) 的 `--theme-*` 令牌解析。

| 表面层级 | 令牌与原语 | 适用场景 | 约束 |
| --- | --- | --- | --- |
| 底布层（Canvas） | `--theme-canvas` | 页面背景与温和渐变晕染 | 不直接承担强投影或重分割块 |
| 内容纸面（Surface） | `--theme-surface`（`.ui-sheet`）、`--theme-surface-tint`（`.ui-subsheet`） | 条件设置卡、推荐方案、首页情报卡与次级信息组 | 保留 `1px solid var(--theme-border-soft)` 细边；卡片头用浅底与底部细线，不用大块实心 `--theme-secondary` 压顶 |
| 浮层与操作层（Overlay / Dock） | `.ui-dock`（`--theme-dock-bg`）、`.ui-dialog` | 底部悬浮计算条、模态选择器和确认窗 | `backdrop-filter` 隔离到 `::before` 伪元素（见第 3 节） |

- **主色与辅助色职责**：`--theme-accent` / `--theme-action` 承担主按钮、当前激活项（标签切换、`aria-pressed="true"`、选中卡片高亮）与键盘焦点；`--theme-secondary` / `--theme-surface-secondary` 承担辅助状态标签与信息徽章。
- **游戏语义色隔离**：属性、稀有度、谱面难度、激奏类别（`just` / `combo` / `luck`）保留游戏内可辨识色彩，不随页面主题被强行染成同色；在 [theme-tokens.css](../../site/src/styles/theme-tokens.css) 之外使用固定色值时，必须在同规则中添加 `/* Game semantics: ... */` 注释以符合主题契约检查。

## 2. 排版、字体、圆角、标尺与共享控件原语

基础刻度与控件原语由 [design-foundation.css](../../site/src/styles/design-foundation.css) 与 [global.css](../../site/src/styles/global.css) 统一定义：

- **统一无衬线字体栈与标准字重**：正文与标题共用系统无衬线协同字体栈（`--font-display: var(--font-body)`，不再在界面标题、正文中混用衬线宋体或外文几何体），标准字重严格收敛至 `400` / `500` / `600` / `700`（禁止使用 `650` / `750` 等非标准插值字重）；**UI 日期、时间、谱面等级与统计计数统一沿用 `--font-body` 配合 `font-variant-numeric: tabular-nums` 等宽数字对齐**，`--font-mono` 仅限键盘快捷键、原始 ID 与调试/代码片段使用。
- **12px 最小字号底线**：新增或重构页面的可见正文、辅助标签、微章与徽章内数字统一 `>= 12px`；交付前用 [typography_audit.py](../../tools/typography_audit.py) 审计相关 CSS。
- **4 档圆角**：`--ds-radius-xs`（`4px`，标签与角标）、`--ds-radius-sm`（`8px`，表单控件、按钮与 `.ui-subsheet`）、`--ds-radius-md`（`12px`，`.ui-sheet`、`.ui-dock`、`.ui-dialog`）、`999px`（`--ds-radius-pill`，胶囊筛选器、分段切换、快捷预设、开关轨道与圆形头像）。
- **紧凑控件标尺**：`--ds-control-sm`（`26px`，行内小胶囊与轻量操作）、`--ds-control-md`（`32px`，摘要开关与中型动作）、`--ds-control-lg`（`36px`，主要按钮上限）；其中常规输入、下拉框与一体式步进器（`.ui-input` / `.ui-select` / `.ui-stepper`）统一 `30px` 高度，次级按钮与纯图标按钮（`.ui-btn-soft` / `.ui-btn-outline` / `.ui-btn-ghost` / `.ui-icon-btn`）为 `28px`，分段按钮为 `25px`，确保高密度工具条与移动端不显笨重臃肿。
- **标准控件原语清单**：
  - **按钮层级**：`.ui-btn-primary`（页面或卡片唯一主行动，`34px`）、`.ui-btn-soft`（淡底柔色次操作，如「修改条件」「管理卡库」）、`.ui-btn-outline`（纸面白底框线按钮，用于模态取消与平级次操作）、`.ui-btn-ghost`（无边框轻操作，如卡片右上「收起」与「取消」）、`.ui-icon-btn`（`28×28px` 纯图标按钮，可选 `.ui-icon-btn--circle` / `.ui-icon-btn--outline`）。
  - **下拉框（`.ui-select`）**：隐藏浏览器原生粗糙箭头（`appearance: none`），改用引用 `var(--theme-muted)` / `var(--theme-accent)` 的纯 CSS 渐变折线箭头（禁止在内联 SVG URL 中写死单一深/浅色十六进制色值，确保 18 套主题与 `night` 深色模式自动适配；工具公共复位样式必须使用 `background-color` 而非 `background` 简写，以免清空折线箭头）。
  - **文本输入与一体式步进器（`.ui-input` / `.ui-stepper`）**：`input[type="number"]` 由 [workbench-dialog.mjs](../../site/src/lib/workbench-dialog.mjs) 增强为左 `−`（`.ui-stepper-btn`）/ 中等宽无框输入（`.ui-stepper-input`）/ 右 `+`（`.ui-stepper-btn`）的 `.ui-stepper`，外框统一承接边框与 `:focus-within` 高光，左右按钮仅以内部分割细线相接，隐藏原生上下微调键；工具样式的通用 `input` / `button` 复位必须通过 `:where(:not(..., .ui-stepper-input))` 与 `:where(:not(..., .ui-stepper-btn))` 豁免，严禁形成“套娃双边框”；常用数值下附 `.ui-quick-presets`（`24px` 胶囊快捷预设）。
  - **分段控制条（`.ui-segmented`）与无框单选胶囊（`.ui-choice-pills`）**：`.ui-segmented` 通过 [theme-tokens.css](../../site/src/styles/theme-tokens.css) 派生的 `--theme-control-track`、`--theme-control-active-bg`、`--theme-control-active-edge`、`--theme-control-active-ink` 四枚控制表面令牌解析凹槽轨道与激活滑块（深色 `night` 预设单独加深轨道并抬升激活项对比度）；包含表单全宽轨道（`.ui-segmented--block`）与紧凑数值刻度（`.ui-segmented--compact`，配合 `tabular-nums`）。6–7 项离散数值或评分刻度改由 [workbench-controls.mjs](../../site/src/lib/workbench-controls.mjs) 生成无外槽 `.ui-choice-pills`（`data-segmented-style="pills"`），消除多行重槽堆积感。
  - **开关与折叠子卡（`.ui-switch` / `.ui-subfold`）**：布尔开关使用 `role="switch"` + `.ui-switch` 纯 CSS 滑轨；低频高级配置收敛进 `.ui-subfold`，标题右侧显示当前摘要小字并带旋转 CSS 箭头。
  - **标签（`.ui-tag`）**：提供 `--accent`、`--secondary`、`--success`、`--warning` 与 `--pill` 变体。

## 3. 页面标题、版本切换与工作台骨架

- **单一可见页面标题与内联版本切换**：
  - [BaseLayout.astro](../../site/src/layouts/BaseLayout.astro) 中的顶栏 `.site-breadcrumb` 承担当前页面唯一可见标题；页面正文保留 `<h1 class="sr-only">` 满足可访问性与副本契约检查，不再额外渲染高耸的大标题横幅或首页重复宣言条／英文装饰 `kicker`。
  - 区分国际服／日服版本的页面启用 [PageEditionSwitcher.astro](../../site/src/components/PageEditionSwitcher.astro) 的 `inline` 模式，将其停靠于 `.site-header-lead` 内、紧邻 `.site-breadcrumb` 同行排布（保持 `<header data-site-header>` 直接 Astro 组件子级结构不变），不再在主内容区上方单独占据一整行；`?unavailable` 提示通过正文顶部 `:empty` 自动隐藏的 `.page-edition-notice[data-edition-message]` 承载。
- **全站统一顶栏个人中心与居中弹窗工作台（账号同步 / 卡库与队伍 / 我的歌单）**：
  - 由挂载于 [BaseLayout.astro](../../site/src/layouts/BaseLayout.astro) 的 [GlobalWorkspaceDock.astro](../../site/src/components/GlobalWorkspaceDock.astro) 收纳进顶部粘性页头 `.site-header` 的 `.site-header-hub`：桌面展示轻量顶栏个人入口（「卡库」「歌单」「账号同步」，隐藏零值计数徽章并用 `.site-header-hub::after` 与区域语言切换分隔）；`<= 1100px` 移动端收敛为 `.global-hub-mobile-btn` 圆钮并弹出 `.global-hub-popover` 菜单提供三项工作台入口，左侧栏不再重复放置个人中心条目。
  - [AccountSyncHub.astro](../../site/src/components/AccountSyncHub.astro)（`.account-hub-dialog`）、[SharedTeamWorkspace.astro](../../site/src/components/SharedTeamWorkspace.astro)（`.tw-panel`）与 [SharedPlaylistWorkspace.astro](../../site/src/components/SharedPlaylistWorkspace.astro)（`.playlist-dialog`）统一为桌面居中弹窗尺寸（`min(1060px, calc(100vw - 40px)) × min(86dvh, 780px)`、`18px` 圆角，移动端 `<= 760px` 统一切换一致尺寸）并共享三段切换头 `.ws-sheet-switch`（「账号同步 | 养成与队伍 | 我的歌单」）与 `.ui-icon-btn` 关闭按钮，跨面板切换采用「先打开目标弹窗再关闭旧弹窗」的无闪烁交接；工作台内部采用全站统一的 `--theme-*` 色彩、圆形乐队图标 / 纯图标筛选与引导式空状态卡片，解除工具页旧样式对 `.tw-panel` / `.ux-card-picker` 的字号与布局覆盖；全站所有登录入口统一呼出「账号同步中心」。
- **轻量 `i` 说明气泡（`.ui-tip-disclosure`）**：
  - 将原先铺在页脚或工具底部的长段落范围说明（如排行榜「口径」「估算说明」、歌曲计算、AP 估分、工具目录、账号安全说明）统一收敛为标题栏或工具条旁的紧凑 `.ui-tip-disclosure` 圆角胶囊/图标按钮，支持桌面悬停与移动端点击展开，同时自动根据横坐标调整左/右弹出对齐（`data-tip-align`），不挤占表格与工作台可视高度。
- **歌曲排行榜详情弹窗与桌面视口优化**：
  - [歌曲排行榜](../../site/src/pages/tools/song-ranking/index.astro) 顶部区服切换并入顶栏内联 [PageEditionSwitcher.astro](../../site/src/components/PageEditionSwitcher.astro)，原表格内展开行升级为居中的 `.ranking-detail-dialog` 弹窗（支持头栏「上一首 / 下一首」与键盘左右方向键顺滑翻曲，并直接在顶部叠加打开 `RankingChartDialog`）。
- **首页活动情报、激奏舞台与右侧个人面板平衡**：
  - [HomeEvents.astro](../../site/src/components/HomeEvents.astro) 将 `.home-events-switcher` 置于活动横幅上方（移动端单行横向滑动 + 手势滑动切期），活动时间下方提供音轨节拍风活动进度条，首张活动封面设 `fetchpriority="high"` 优先加载；首页顶部概览区下方接入 [HomeArena.astro](../../site/src/components/HomeArena.astro) 实时 5 乐队激奏舞台状态条；右侧栏在 `HomeBirthdays`（优先角色大头贴）下方追加自适应伸缩的 `.home-personal-sheet`；`近期留影` 桌面与移动端均采用左侧 `16:9` 图面 + 右侧紧凑元信息单行横卡。
- **核心工具工作台结构**：「顶部两栏可折叠纸面条件卡 + 底部悬浮计算条」：
  1. **展开态（Setup）**：顶部展示可折叠纸面卡，不重复显示汇总摘要条；条件项分左/右均衡两栏排布，但仅存在单一维度控件时隐藏空右栏（`data-single-col="true"`）。
  2. **条件扩展子卡（如临时纳入本期奖励卡）**：开关开启前保持与同行其他轻开关平齐紧凑；开启后将扩展面板整行独占展开（`flex-basis: 100%` / `grid-column: 1 / -1`）为 recessed `.ui-subsheet` 浅底卡片（标题计数徽章 `.ui-tag` + 横向养成度下拉 + 2 列迷你候选卡），严禁把相邻开关或输入框挤成畸形窄栏。
  3. **收起态（Running / Results / 手动收起）**：条件卡折叠为单行多段 `.ui-summary-strip`（`> span` 以左竖线分隔）。在 `<= 760px` 窄屏换行时转成带细边框的小胶囊（避免换到下一行行首遗留孤立的 `|` 分割线）。
  4. **弹出层不被裁切**：含相对定位悬浮面板的折叠卡（如成绩参数浮层）外层不设 `overflow: hidden`，由页头自身承接顶部圆角。
  5. **底部悬浮计算条合成隔离**：固定定位悬浮条（`.ui-dock`、`.arena-run`、`.event-action-dock`）将背景色与 `backdrop-filter: blur(12px)` 放在 `::before` 伪元素内（主容器设 `isolation: isolate; transform: translate3d(0, 0, 0); background: transparent`），直接子节点设 `position: relative; z-index: 1`，避免 Chromium 在状态或主题切换时将前景按钮误合成成空白模糊块。
  6. **页脚安全留白**：含底部悬浮条的页面由 `design-foundation.css` 为 `.site-footer` 追加底部留白，确保页脚说明和链接滚动到底时不被遮挡。

## 4. 图标与游戏素材使用准则

原则：**能用清晰图标或游戏原生素材直观表达的信息，优先使用，并按场景与容器形态控制尺寸与留白，做到首屏易辨、不过度堆叠。**

| 类别 | 组件 / 来源 | 推荐使用场景 | 尺寸与排版规范 | 克制边界与无障碍要求 |
| --- | --- | --- | --- | --- |
| 站点功能 SVG | [ToolGlyph.astro](../../site/src/components/ToolGlyph.astro)、[tool-task-switcher.mjs](../../site/src/lib/tool-task-switcher.mjs) | 导航分类、快捷入口、工作台模式标签（如收益配队 / 冲榜 / 速算）、工具按钮与弹窗关闭图标 | 统一线性描边（`stroke-width` 1.6–1.8）；与中文/英文短标签同行并排 | 表格数据项、密集表单标签不强加装饰图标；纯图标关闭/移除按钮改用 `.ui-icon-btn` + SVG（不用文本 `×` 或「关闭 ×」）；纯装饰加 `aria-hidden="true"` |
| 属性徽章 | [CardAttributeBadge.astro](../../site/src/components/CardAttributeBadge.astro)、[filter-visuals.ts](../../site/src/lib/filter-visuals.ts) | 活动加成属性、舞台属性筛选、曲目与卡面分类 | `20–24px` 正方图标；纯图标（`iconOnly` / `.card-attribute-badge--icon-only`）与筛选图标静息及悬停状态去外边框与外圆圈；激活 `[aria-pressed="true"]` 时仅施加单层 `1.5px` + `4px` 主题光晕 | 深浅主题不得施加滤镜变色；仅展示图标时务必带 `title` / `aria-label` 或视觉隐藏文本 |
| 乐队标识 | [BandMark.astro](../../site/src/components/BandMark.astro)（`round` / `logoAssetId`）、[filter-visuals.ts](../../site/src/lib/filter-visuals.ts) | 筛选按钮组、加成条件带、曲目/卡牌/留影/生日行内小标；首页活动主卡与专题页头 | 筛选组及高密度行内位统一优先用自带圆廓的圆形徽标（`bandCircleIcon` / `<BandMark round />`，`18–26px`），**静息与悬停不额外加套白色边框或圆盒**，激活态只呈现单层主题光晕；宽松主卡头保留文字宽标（`width: auto; max-width: 44–52px; height: 18–24px; object-fit: contain`） | 缺失圆形徽标时经 `data-fallback-icon` 安全回退宽标或可读文字，不强压进方形容器或裁剪文字宽标 |
| 角色头像与曲封 | `getAsset`、人物头像与曲封资源 | 活动加成角色行、近期生日 2×2、歌曲行与活动曲选卡 | 头像裁切为 `24–42px` 圆形；曲封用 `42–56px` 圆角（`6–8px`）；写明尺寸或 `aspect-ratio` | 同一位置最多展示直接相关的少数组头像（如加成角色前 5 位），避免溢出折行混乱；无图时安全降级 |
| 稀有度与激奏 | [CardRarityBadge.astro](../../site/src/components/CardRarityBadge.astro)、[GekisouTypeBadge.astro](../../site/src/components/GekisouTypeBadge.astro)、[gekisou-visuals.mjs](../../site/src/lib/gekisou-visuals.mjs) | 卡牌角标、曲目激奏触发统计与详情徽章 | 激奏图标小尺寸下辨识度有限，须配超短前缀或完整词显示（如 `J×3` / `C×1` / `L×1` 语义淡底胶囊，或 `<GekisouTypeBadge short />`） | 未取得图标字节时回退显示 `J×N` / `C×N` / `L×N`；统计胶囊不加无意义的 `margin-left: auto` 以防换行错位 |
| 折叠指示与状态符号 | 内联 SVG Chevron（`.arena-chevron`）或 CSS 细线箭头 | 展开/收起浮层、子折叠区标题、场次触发器、高级选项说明 | 保持与控制按钮同高对齐并保留旋转过渡 | 统一避开裸 Unicode 三角/符号（`▸`/`▾`/`▼`/`✳`/`×`），消除跨字体基线贴字与锯齿问题 |

多主题下保护游戏素材的核心约定：**不对彩色游戏图素执行色相过滤或暗化反色**，而是借助 `--theme-surface` / `.ui-subsheet` 的纸感托底与 `1px solid var(--theme-border-soft)` 细边隔开背景，确保深浅共 18 套主题下辨识度一致。

## 5. 控件选型与信息减法准则

避免在同一页面出现“什么都用原生下拉框”或“太多带框分段条上下堆叠挤成一团”的问题，交互选型遵循以下优先顺序：

| 选项特征 | 推荐控件 | 示例与规则 |
| --- | --- | --- |
| 2–3 个核心互斥模式 | `.ui-segmented`（`--block`） | 演出类型、计算阶段、使用卡片、操作样本（`1组 / 3组`）；同一表单栏内纵向堆叠原则上不超过 2–3 条分段条，防止重框挤压 |
| 同栏次级 3–4 项互斥选项 | 两列配对 `.ui-select` | 如「收益目标 + 档位估算」「挑战档位估算」等非主流程开关，收纳为紧凑两列下拉框为工作台腾出呼吸感 |
| 6–7 项紧凑离散数字／等级刻度 | `.ui-choice-pills`（`data-segmented-style="pills"`） | 每次耗火（`0/1/2/3/4/5/10`）、每次挑战消耗、稳定评分（`D..SS`）；去掉厚重外槽改用轻量独立胶囊 |
| 有限多选且带清晰图标或色阶 | 图标 / 难度切换胶囊（[tool-quick-options.mjs](../../site/src/lib/tool-quick-options.mjs)） | 参赛乐队（用圆形 `bandCircleIcon`）、成员乐队、留影关联乐队、舞台属性、可打难度 `EXPERT..EASY`；仅展示图标时配 `.tool-choice-label` 与 `title` |
| 常用高频档位的连续数字 | `.ui-stepper` + `.ui-quick-presets` | 总耗火（`50/100/300`）、已有挑战 pt（`0/400/800/1600`）、时机波动（`±0ms/±10ms/±20ms/±30ms`）、活动加成 `%`；一体边框内一点即选且保留精调 |
| >= 8 项长文本或动态列表 | `.ui-select` | 活动列表、最高谱面等级（8–40）、自配队对照、技能最少/最多张数矩阵 |
| 二元功能开关 | `.ui-switch`（`role="switch"`） | 临时纳入奖励卡、沿用乐队筛选、自定义歌曲重要程度 |

**信息减法原则**：
- **去掉自明标签与重复文字**：图标（如 `<BandMark iconOnly />`）和下拉选择器（如顶部活动选择器、场次触发器中的 Chevron 箭头）在语境明确时省略重复的「乐队名 / 活动 / 换场次 / ›」赘字，保留 `sr-only` / `aria-label` 与 `title` 兼顾无障碍与悬浮提示。
- **底部栏与折叠头轻量图标化**：关闭、移除、帮助按钮统一为纯图标 `.ui-icon-btn`；移动端窄屏下的底部次按钮可隐藏文字只留图标（保留 `.sr-only` / `aria-label`），把水平空间让给摘要与主计算按钮。

## 6. CSS 架构顺序、覆盖现状与验证清单

- **导入顺序与容器留白契约**：
  1. 页面文件（如首页）必须先导入 [BaseLayout.astro](../../site/src/layouts/BaseLayout.astro)，再导入局部展示组件与页面专属 CSS，防止 `site-shell.css` 反压局部样式（如 `.band-mark` 边框）。
  2. 重构后的工具页面样式（如 `event-workbench.css`、`arena.css`）必须放在旧设计系统与旧原型样式之后；面向旧页面的历史规则优先使用 `:not([data-tool-kind="..."])`、`:not(.event-simple-view)` 或 `:not(.ui-stepper)` 收缩作用范围，不依赖临时 `!important` 对抗；图标按钮若叠加 `html[data-tool-theme] body` 选中态覆盖，需显式对齐同等权重以免方形外框泄漏到圆形乐队／属性徽章。
  3. 共有工具按钮与状态样式统一放在 [theme-surfaces.css](../../site/src/styles/theme-surfaces.css) 与 [tool-colors.css](../../site/src/styles/tool-colors.css) 维护（基础复位统一用 `:where(:not(...))` 零权重包裹以免叠加 `:not()` 权重反压已激活标签、[data-difficulty] 难度键、`.ui-btn-*` 或 `.ui-segmented > button`；同时不得用 `background:` 简写清空 `.ui-select` 折线箭头）。
  4. 含底部固定计算栏（`.event-action-dock`、`.arena-run`、`.ui-dock`）的工具页通过 `body:has(...) #main-content` 保障最小视口高度与底部安全留白，避免短页面首屏将页脚顶到操作条下方重合。
  5. 无头像资源的近期生日角色卡片（如部分新成员条目）在 [HomeBirthdays.astro](../../site/src/components/HomeBirthdays.astro) 回退为角色首字纸面徽章，不显示空白圆圈；SSR 乐队筛选选项优先绑定 `bandCircleIcon` 并与客户端渲染保持一致。
- **当前实施范围**：
  - **先导 5 页（Wave 0）**：共享基础层（[design-foundation.css](../../site/src/styles/design-foundation.css)、[theme-surfaces.css](../../site/src/styles/theme-surfaces.css)、控件增强器 [workbench-controls.mjs](../../site/src/lib/workbench-controls.mjs) / [tool-quick-options.mjs](../../site/src/lib/tool-quick-options.mjs) / [workbench-dialog.mjs](../../site/src/lib/workbench-dialog.mjs)）、[首页](../../site/src/pages/index.astro)、[活动收益（含加成速算）与活动曲冲榜](../../site/src/pages/tools/event-efficiency/index.astro)、[舞台配队](../../site/src/pages/tools/arena/index.astro)与[激奏舞台](../../site/src/pages/arena/index.astro)已完成设计与精修。
  - **Wave 1 高频交互计算与养成工具（9 页，已审核通过）**：[卡组配队](../../site/src/pages/tools/deck-builder/index.astro)、[歌曲计算](../../site/src/pages/tools/song-calculator/index.astro)、[歌曲排行榜](../../site/src/pages/tools/song-ranking/index.astro)、[队伍 AP 估分](../../site/src/pages/tools/ap-grade/index.astro)、[抽卡记录](../../site/src/pages/tools/gacha-history/index.astro)、[Live2D 预览与调试](../../site/src/pages/tools/live2d/index.astro)、[我的养成](../../site/src/pages/my-growth/index.astro)、[养成导入与本地工具](../../site/src/pages/tools/account-export/index.astro)与[游戏工具目录](../../site/src/pages/tools/index.astro)已统一迁入主题令牌、自定义箭头下拉、圆形乐队徽章、`>= 12px` 字号底线与毛玻璃底栏，并随顶部全站登录/卡库/歌单胶囊与管理弹窗完成精修通过审核。
  - **Wave 2–4 全站精修与性能优化（已完成）**：活动、招募、任务、玩家排行榜、更新页、剧情目录与阅读器（含分层纸面、滚动吸顶标题、划词即分享、聊天/字幕/旁白/场景切换演出、自动续载与活动故事折叠直达）、首页激奏舞台条、18 套重构配色（含 5 套乐队代表色）、轻盈 240ms 页面切换与流光进度条已全部完成；构建端（[build_web_client.mjs](../../tools/build_web_client.mjs) / [startup.mjs](../../site/src/runtime/startup.mjs) / [boot.mjs](../../site/src/runtime/boot.mjs)）已落地共享壳层 CSS 抽离（`chunks/shared-shell-*.css`）、三弹窗 CSS 懒加载（`chunks/workspaces-*.css`）、模块脚本并行执行与长列表 `content-visibility: auto`。
- **验收步骤**：
  1. 字号审计：`python3 tools/typography_audit.py ...` 输出 `[]`。
  2. 网站测试与类型检查：运行主题对比度/契约、产品文案契约、移动端顶栏及对应工具测试与 `npm --prefix site run check:calculation`。
  3. 文档检查：`python3 -m tools.docs_status` 与 `python3 -m unittest tests.test_docs_status -q`。
  4. 实机浏览器抽检：在桌面窄/宽屏（`1440×900`）与移动视口（`390×844`）下配合真实内容快照切换 `classic`、`night` 及属性主题，核验折叠态、浮层不裁切、自定义下拉框与开关深浅对比度、悬浮条文字可读与零水平溢出。
