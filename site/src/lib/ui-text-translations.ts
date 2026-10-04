import { teamPlanningEnglish } from "./team-planning-translations.mjs";
import { uiDictionaries } from "./ui-i18n.ts";

const coreTranslations = Object.fromEntries(
  Object.keys(uiDictionaries["zh-CN"]).map((key) => [
    uiDictionaries["zh-CN"][key as keyof typeof uiDictionaries["zh-CN"]],
    uiDictionaries.en[key as keyof typeof uiDictionaries.en]
  ])
);

export const englishExactTranslations: Record<string, string> = {
  ...coreTranslations,
  ...teamPlanningEnglish,
  // Tool filter controls and chart-comparison wording. Exact matches only.
  "含 COMBO": "Has COMBO",
  "含 LUCK": "Has LUCK",
  "含 JUST": "Has JUST",
  "三段 COMBO": "Three COMBO",
  "三段 LUCK": "Three LUCK",
  "三段 JUST": "Three JUST",
  "激奏固定基准": "Fixed Gekisou baseline",
  "综合比较": "Compare both",
  "活动 pt": "Event pts",
  "当前队伍": "Current team",
  "我的卡库": "My collection",
  "档位优先": "Grade first",
  "平均分": "Mean score",
  "最低分": "Minimum score",
  "最高分": "Maximum score",
  "全部歌曲": "All songs",
  "当前谱面": "Current chart",
  "沿用范围": "Use the same collection",
  "快速推荐": "Quick recommendations",
  "完整比较": "Full comparison",
  "队伍加成": "Team bonuses",
  "手动填写": "Enter manually",
  "徽章优先": "Badges first",
  "活动 pt 优先": "Event points first",
  "手填档位": "Manual grade",
  "短歌优先": "Short songs first",
  "排列顺序": "Sort order",
  "加成优先": "Bonus first",
  "名称": "Name",
  "卡片范围": "Card pool",
  "卡名或角色名": "Card or character name",
  "选择卡片": "Choose a card",
  "关闭卡片选择": "Close card picker",
  "关闭 ×": "Close ×",
  "已保存队伍": "Saved teams",
  "选择一支队伍": "Choose a team",
  "演出": "Performance",
  "普通": "Ordinary",
  "挑战": "Challenge",
  "挑战活动": "Challenge event",
  "判档依据": "Grade estimate",
  "估分优先": "Score first",
  "歌曲搜索": "Search songs",
  "输入歌曲名称": "Enter a song name",
  "档位优先时，同档歌曲按时长排列。": "Songs with the same grade are sorted by duration when Grade first is selected.",
  "左右滑动查看五个位置 · 点击卡位即可更换": "Swipe to see all five slots · Select a slot to change its card",
  "模式与榜单": "Mode and ranking",
  "排名口径": "Ranking basis",
  "同一条件下比较谱面": "Compare charts with matching settings",
  "演出模式": "Performance mode",
  "演出类型": "Performance type",
  "普通演出": "Ordinary live",
  "激奏演出": "Gekisou live",
  "挑战演出": "Challenge live",
  "查看榜单": "View ranking",
  "榜单": "Ranking",
  "出分榜": "Score ranking",
  "效率榜": "Efficiency ranking",
  "达档综合力": "Power needed for grade",
  "其他排序": "Other sorting",
  "按当前榜单": "Use ranking order",
  "歌曲筛选": "Song filters",
  "清空筛选": "Clear filters",
  "重置筛选": "Reset filters",
  "搜索歌曲": "Search songs",
  "歌曲名或关键词": "Song name or keywords",
  "难度": "Difficulty",
  "及以下": "or lower",
  "最长时长": "Maximum duration",
  "秒以内": "seconds or less",
  "已选筛选": "Active filters",
  "计算条件": "Calculation settings",
  "同一条件同时用于出分、效率和达档比较": "The same settings apply to scores, efficiency and grade comparisons",
  "效率时长": "Duration for efficiency",
  "谱面时长": "Chart duration",
  "音频时长": "Audio duration",
  "歌曲技能条件": "Song skill settings",
  "技能组合": "Skill setup",
  "基准五技能": "Five baseline skills",
  "无加分技能": "No score skills",
  "我的五个技能": "My five skills",
  "五个技能分别发动一次": "Each of the five skills activates once",
  "将技能 1 应用于全部": "Apply skill 1 to all",
  "加分（%）": "Score bonus (%)",
  "持续时间": "Duration",
  "秒": "sec",
  "填写技能的加分与时长即可；计算会遍历发动顺序。时长支持 0–20 秒，每档 0.5 秒。": "Enter each skill's bonus and duration; all activation orders are evaluated. Durations range from 0 to 20 seconds in 0.5-second steps.",
  "逐谱精算": "Recalculate each chart",
  "可选": "Optional",
  "基准榜已预先逐音符计算，可直接使用。调整技能或帧率后，可对筛出的谱面重新计算。": "The baseline ranking already includes note-by-note calculations. After changing skills or frame rate, you can recalculate the filtered charts.",
  "当前列表": "Current list",
  "全部筛选结果": "All filtered charts",
  "已完成精算": "Recalculated charts",
  "理想帧率": "Ideal frame rate",
  "计算范围": "Calculation scope",
  "当前排序前 25 张": "Top 25 in current order",
  "当前筛选全部": "All filtered charts",
  "开始逐谱精算": "Recalculate charts",
  "只比较已完成的谱面，不代表全库名次": "Only completed charts are compared; these are not full-library ranks",
  "达档比较条件": "Grade comparison settings",
  "已有分数": "Your score",
  "可选，输入分数直接判档": "Optional: enter a score to check its grade",
  "达档综合力由当前条件下的得分近似反推，数值越低，达到目标档位所需综合力越少。显示到千位，不是实打保底；真实技能、活动加成及逐音符取整仍会影响结果。": "Required power is estimated from the score under the current settings. Lower values mean less power is needed for the target grade. Values are rounded up to the nearest thousand and are not a guaranteed result; actual skills, event bonuses and per-note rounding still matter.",
  "基准、快速估算与逐谱精算有什么区别？": "How do the baseline, quick estimate and chart recalculation differ?",
  "普通基准：100,000 综合力、五次 +100% / 5 秒技能，已预先逐音符计算。无加分技能使用同一谱面的无技能基础分，两者打开即可比较。": "The ordinary baseline uses 100,000 power and five +100% skills lasting 5 seconds each, calculated note by note in advance. No score skills uses the same chart's base score without skills. Both are ready to compare immediately.",
  "我的五个技能：先用技能窗口表快速估算，修改条件即可看结果。需要比较接近的候选时，再运行逐谱精算，逐个音符计算技能覆盖、浮点累积与取整，并遍历 120 种发动顺序。": "My five skills first uses precomputed skill windows for a quick estimate as you change settings. For close candidates, recalculate each chart to evaluate skill coverage, floating-point accumulation and rounding for every note across all 120 activation orders.",
  "P10 是 120 种等可能顺序由低到高的第 12 个分数；范围反映技能顺序差异，不是实战保底。精算只对本次完成的谱面排名，可随时切回全部筛选结果。": "P10 is the 12th lowest score among 120 equally likely skill orders. The range reflects skill-order variation, not a guaranteed play result. Recalculation ranks only the charts completed in this run; you can switch back to all filtered charts at any time.",
  "以上按 AP、满生命、无条件加分技能比较。激奏使用固定基准。需要真实卡牌技能、非 AP 判定或活动加成时，从歌曲明细进入队伍计算器。": "These comparisons assume AP, full life and unconditional score skills. Gekisou uses a fixed baseline. For actual card skills, non-AP judgements or event bonuses, open the team calculator from a song's details.",
  "比较结果": "Comparison results",
  "张谱面": "charts",
  "统一曲库 · 固定基准": "Shared library · Fixed baseline",
  "本次筛选的选曲推荐": "Song recommendations for these filters",
  "歌曲、难度及统一基准下的分数与效率": "Songs, difficulties, scores and efficiency under a shared baseline",
  "歌曲 / 难度": "Song / Difficulty",
  "基准得分 ↓": "Baseline score ↓",
  "每秒得分": "Score per second",
  "转分倍率": "Score-to-power ratio",
  "倍率明细": "Multiplier breakdown",
  "这次没有找到匹配的谱面": "No matching charts",
  "换个关键词，或放宽难度和乐队筛选。": "Try another keyword or broaden the difficulty and band filters.",
  "第 1–25 项": "Items 1–25",
  "估算范围与限制": "Estimate scope and limits",
  "蓝色看出分，紫色看效率。对比条以当前筛选中的最高值为满格。": "Blue shows score and purple shows efficiency. Each bar is scaled to the highest value among the filtered charts.",
  "统一曲库 · 理想演奏估算": "Shared library · Ideal-play estimates",
  "当前展示普通演出出分榜前 25 项；切换和筛选需要启用 JavaScript。": "Showing the top 25 ordinary-live scores. Enable JavaScript to switch rankings or apply filters.",
  "按技能组合与谱面时长，比较出分、效率和达档所需综合力。": "Compare scores, efficiency and power needed for grades using your skill setup and chart duration.",
  "基准使用 100,000 综合力，五次 +100% 加分技能、每次 5 秒；AP、满生命、无辅助。普通基准已在发布数据时逐音符计算，打开即可比较。排除卡牌、属性及乐队适配差异，固定基准，不读取个人编成。": "The baseline uses 100,000 power, five +100% score skills lasting 5 seconds each, AP, full life and no assist. Ordinary scores are calculated note by note when the data is published. This fixed baseline excludes card, attribute and band compatibility differences and does not use your team.",
  "激奏统一三段第一、零判定偏差、60 FPS，不加入卡牌专属激奏技能。LUCK 使用固定种子 20260927、2 批抽样，每个数据版本预先生成同一份结果；随机谱面为 240 个样本。结果稳定可复现，不是实战必然得分。": "Gekisou assumes first place in all three sections, zero timing offset and 60 FPS, without card-specific Gekisou skills. LUCK uses seed 20260927 and two batches, with 240 samples for random charts. Each data release includes the same reproducible results; these are not guaranteed play scores.",
  "每秒得分 = 当前条件得分 ÷ 所选时长。谱面时长从零点至最后事件；音频时长包含音频首尾。不含加载与结算时间；缺少时长不参与效率排名。": "Score per second equals the current score divided by the selected duration. Chart duration runs from zero to the last event; audio duration includes the full audio. Loading and result screens are excluded. Charts without duration data are excluded from efficiency rankings.",
  "转分倍率 = 基准得分 ÷ 100,000。难度倍率 = 1 +（等级 − 5）× 0.005。连击倍率按音符分值权重加权；技能倍率为普通得分相对无技能分的增益。各项均保留游戏计分中的取整，不能直接相乘还原总分。": "Score-to-power ratio = baseline score ÷ 100,000. Difficulty multiplier = 1 + (level − 5) × 0.005. The combo multiplier is weighted by note value; the skill multiplier compares the ordinary score with the no-skill score. Each includes game scoring rounding, so multiplying them does not reproduce the total score exactly.",
  "按原始数值排序，相同结果采用 1、1、3 并列名次。激奏样本极值不是理论极值，接近的随机谱面不代表确定强弱。此榜用于比较谱面，不是实战成绩或活动收益榜。达档综合力 = 目标分数线 × 基准综合力 ÷ 所选技能口径的基准得分，是近似反推；排名使用未舍入值，展示值向上取到千位。": "Rankings use unrounded values, with ties ranked 1, 1, 3. Gekisou sample extremes are not theoretical limits, and small differences between random charts do not establish a definite winner. This compares charts, not actual play results or event rewards. Required power is estimated as target score × baseline power ÷ score under the selected skills. Ranks use unrounded values; displayed power is rounded up to the nearest thousand.",
  "还没选歌。点击一个难度开始。": "No song selected. Choose a difficulty to begin.",
  "定位已选": "Show selection",
  "找歌曲": "Find a song",
  "歌名或乐队，支持多个关键词": "Song or band name; multiple keywords supported",
  "筛选歌曲属性": "Filter song attributes",
  "筛选卡片属性": "Filter card attributes",
  "演奏乐队": "Performing band",
  "全部难度": "All difficulties",
  "激奏段落": "Gekisou sections",
  "全部组合": "All combinations",
  "包含 COMBO": "Includes COMBO",
  "包含 LUCK": "Includes LUCK",
  "包含 JUST": "Includes JUST",
  "三个 COMBO": "Three COMBO sections",
  "三个 LUCK": "Three LUCK sections",
  "三个 JUST": "Three JUST sections",
  "混合类型": "Mixed types",
  "默认顺序": "Default order",
  "歌曲名称": "Song name",
  "谱面等级从高到低": "Chart level: high to low",
  "最低等级": "Minimum level",
  "点击歌曲右侧的难度即可选中。": "Select a difficulty beside a song to choose its chart.",
  "没有符合条件的谱面，试试放宽等级范围或重置筛选。": "No matching charts. Broaden the level range or reset the filters.",
  "上一页歌曲": "Previous songs",
  "下一页歌曲": "Next songs",
  "全部激奏效果": "All Gekisou effects",
  "全部普通技能": "All ordinary skills",
  "持有情况": "Ownership",
  "全部卡片": "All cards",
  "已拥有": "Owned",
  "未录入": "Not recorded",
  "普通技能": "Ordinary skills",
  "纯加分": "Score bonus",
  "血量条件加分": "Life-based score bonus",
  "判定条件加分": "Judgement-based score bonus",
  "分卡 / 延时": "Score / Duration extension",
  "判定辅助": "Judgement assist",
  "生命回复": "Life recovery",
  "稀有度优先": "Rarity first",
  "卡片编号从新到旧": "Card ID: newest first",
  "没有符合条件的卡片。可重置筛选，或取消“已拥有”限制。": "No matching cards. Reset the filters or disable the Owned restriction.",
  "限定乐队、属性（可选）": "Limit band and attribute (optional)",
  "底部是开始，向上查看后续音符。点选音符可查看原始位置、宽度与判定时间。": "Read from the bottom upward. Select a note to inspect its original position, width and judgement time.",
  "谱面查看方式": "Chart view",
  "滚动分析": "Scrolling analysis",
  "2D 分段图": "2D sections",
  "↓ 前一段": "↓ Previous section",
  "↑ 后一段": "↑ Next section",
  "整曲 2D 分段谱面": "Full-song 2D chart sections",
  "谱段图册": "Chart atlas",
  "每段 4 秒，按编号逐段阅读；每段从底部开始。": "Each numbered section covers 4 seconds. Read each section from the bottom upward.",
  "导出图册": "Export atlas",
  "开始时间": "Start time",
  "曲尾": "End of song",
  "查看时段": "View time range",
  "恢复全曲": "Reset to full song",
  "支持秒数或分:秒，例如 30.5 或 1:02；留空表示起点或曲尾。": "Use seconds or minutes:seconds, such as 30.5 or 1:02. Leave blank for the start or end of the song.",
  "谱段定位": "Find a chart section",
  "跳至谱段": "Go to section",
  "返回图册": "Back to atlas",
  "上一段": "Previous section",
  "下一段": "Next section",
  "按时间排列的谱段": "Chart sections in time order",
  "点击轨道中的 Tap、Flick、Trace 或 Long 节点，查看时间、位置和当前事件。": "Select a Tap, Flick, Trace or Long note in the lanes to inspect its time, position and event.",
  "逐音符判定回放": "Note-by-note judgement replay",
  "可选，普通演出": "Optional · ordinary live",
  "判定条件": "Judgement inputs",
  "全 Perfect、满生命参考": "All-Perfect, full-life reference",
  "使用输入的逐音符判定": "Use supplied note judgements",
  "模板包含当前谱面的全部计分节点。修改 judgement 和 inputFrame 后应用，按指定技能顺序回放一次。1＝Miss、2＝Bad、3＝Good、4＝Great、5＝Perfect、6＝Just。帧序号从 0 开始；scoreIndex、timeMs 与谱面标识请保留。": "The template includes every scoring event in this chart. Edit judgement and inputFrame, then apply to replay once with the specified skill order. 1 = Miss, 2 = Bad, 3 = Good, 4 = Great, 5 = Perfect, 6 = Just. Frame numbers start at 0; keep scoreIndex, timeMs and the chart identifiers unchanged.",
  "下载当前谱面模板": "Download chart template",
  "导入 JSON": "Import JSON",
  "判定 JSON": "Judgement JSON",
  "选择歌曲后下载模板，填写并导入，或在此粘贴 JSON": "Choose a song, download and fill in the template, then import it or paste JSON here",
  "应用并计算": "Apply and calculate",
  "恢复 AP 参考": "Reset to AP reference",
  "尚未导入判定。模板是可编辑的模拟输入，不是实战记录。": "No judgements imported. The template is editable simulated input, not a record of actual play.",
  ...Object.fromEntries([1, 2, 3].map(index => [`第 ${index} 段结果确认额外等待（帧）`, `Section ${index} result confirmation delay (frames)`])),
  "默认全 Perfect（AP）、满生命。不同技能顺序会带来分数变化，以下显示参考平均分和范围。": "Assumes all Perfect (AP) and full life. Skill order changes the score; the mean and range below are estimates.",
  "导入自己的养成，按步骤选歌、准备卡库、获得推荐，也可比较队伍与换卡。": "Import your progress, choose a song and collection, then get recommendations or compare teams and swap cards.",
  "先在卡组配队页准备队伍，再在这里比较歌曲、难度与演出模式。": "Prepare your team in Team Builder, then compare songs, difficulties and performance modes here.",
  "查看配队设置 →": "View team settings →",
  "选一首歌，导入你的养成，找到适合自己的成员与留影组合。": "Choose a song, import your progress, and find a member and snap lineup for your account.",
  "选歌 → 卡库 → 演出条件 → 推荐": "Song → Collection → Settings → Results",
  "确定卡库和演出条件，比较成员、留影与队长的搭配。": "Choose your collection and performance settings to compare members, snaps and leaders.",
  "按实际养成比较": "Compare with your progress",
  "带入队伍与养成，查看预估分数、技能覆盖和计分明细。": "Bring your team and progress to review score estimates, skill coverage and scoring details.",
  "平均分 · 分数范围 · 明细": "Average · Range · Breakdown",
  "用同一基准比较谱面出分与时间效率，挑选下一首歌。": "Compare chart scores and time efficiency using the same baseline to choose your next song.",
  "普通演出 / 激奏演出": "Ordinary / Gekisou",
  "角色 · 服装 · 动作": "Characters · Costumes · Motions",
  "从自己的卡库出发，配队、估分、选歌；也可以打开角色预览。": "Build teams, estimate scores and choose songs using your collection, or explore character previews.",
  "5 项工具": "5 tools",
  "配队 · 养成导入": "Teams · Progress import",
  "配队 · 组合比较": "Teams · Lineup comparison",
  "计分 · 队伍分析": "Scores · Team analysis",
  "选歌 · 得分与效率": "Songs · Scores and efficiency",
  "角色 · 互动预览": "Characters · Interactive previews",
  "导入自己的养成，按四步引导选择歌曲、准备卡库并获得推荐。": "Import your progress and follow four steps to choose a song, prepare your collection and get recommendations.",
  "开始配队 →": "Build a team →",
  "网页登录直接读取，或用本地工具导出 JSON，再导入配卡工具。": "Read progress with web login, or export JSON locally and import it into the team builder.",
  "台港澳服 · BHK 账号": "TW/HK/MO · BHK account",
  "暂停开放": "Temporarily closed",
  "激奏对战实验室 · 暂停开放": "Gekisou battle lab · Temporarily closed",
  "此模块暂时关闭。你仍可以在配卡工具中选择激奏演出，比较队伍。": "This module is temporarily closed. Gekisou team comparisons remain available in the team builder.",
  "前往卡组配队 →": "Open team builder →",
  "返回游戏工具": "Back to tools",
  "筛选歌曲": "Filter songs",
  "筛选成员与留影": "Filter members and snaps",
  "筛选我的卡库": "Filter my collection",
  "已选筛选条件": "Selected filters",

  "选择角色预览、编成、歌曲计分或激奏工具开始使用。": "Choose character previews, team building, score calculation or Gekisou tools.",
  "选择角色与服装，播放动作和表情，实时调节模型参数。": "Choose a character and costume, play motions and expressions, and adjust model parameters live.",
  "打开角色工作台 →": "Open character studio →",
  "项可用（含估算）": "available (including estimates)",
  "曲目与谱面": "Tracks and charts",
  "按乐队、角色、BPM 与难度查找曲目，再进入谱面查看谱面结构。": "Find tracks by band, character, BPM and difficulty, then inspect their charts.",
  "谱面分析": "Chart analysis",
  "歌曲连续浏览": "Browse tracks",
  "歌曲": "Track",
  "← 上一项": "← Previous",
  "下一项 →": "Next →",
  "非官方玩家资料站，内容以所选服务器与资料版本为准。": "Unofficial player resource. Availability depends on the selected server and data version.",
  "可用工具与研究功能": "Available tools and research features",
  "3 项可用": "3 available",
  "2 项等待验证": "2 awaiting validation",
  "尚不能输出正式结果": "Formal results unavailable",
  "查看需要补充的验证 →": "See the evidence still needed →",
  "真实计分规则确认前不执行组合搜索，避免把基础值排序误当成最佳卡组。":
    "Combination search stays off until real scoring rules are confirmed, so base-stat sorting is not mistaken for an optimal team.",
  "查看仍需验证的内容 →": "See what still needs validation →",
  "编成草稿": "Formation draft",
  "选择 5 张成员卡和 5 张留影，查看基础值与技能摘要，并保存编成草稿。这里不会把基础值称为正式综合力或歌曲分数。":
    "Choose five member cards and five snaps, review base stats and skill summaries, and save a formation draft. Base stats are not presented as formal team power or a song score.",
  "基础资料": "Base data",
  "歌曲分数核对": "Song score verification",
  "目前不能输出正式歌曲分数；你仍可以核对编成、歌曲、难度与判定输入。要开放计算，还需要同一局可归属的真实结果完成整数对账。":
    "Formal song scores are not available yet. You can still verify the formation, song, difficulty, and judgement inputs. Calculation requires an attributable result from the same play to reconcile exact integers.",
  "暂不可计算": "Calculation unavailable",
  "等待真实对局": "Waiting for a real play",
  "完成精确核对": "Exact reconciliation required",
  "卡组最佳化": "Team optimization",
  "目前不能给出正式最佳卡组；你可以先建立可保存的编成草稿。要开始比较组合，还需要真实对局确认计分规则。":
    "A formal optimal team is not available yet. You can first create a saved formation draft. Comparing combinations requires a real play to confirm the scoring rules.",
  "等待真实计分规则": "Waiting for verified scoring rules",
  "建立编成草稿": "Create a formation draft",
  "选择卡牌、歌曲与难度，并保存本次输入。": "Choose cards, a song, and difficulty, then save this input.",
  "等待真实样本": "Waiting for a real sample",
  "核对歌曲分数": "Verify song score",
  "游戏模式资料": "Game mode data",
  "可以查看 Battle Live 与撃奏的现有资料。Arena 目前只有系统概览，还没有可查看的真实赛季、排行榜或奖励内容。":
    "You can browse the available Battle Live and Gekisou data. Arena currently has only a system overview, with no real season, leaderboard, or reward content available.",
  "当前收录": "Currently listed",
  "种模式资料": " game modes",
  "当前可查看": "Available now",
  "资料可查看不代表规则模拟或联网服务已经可用。": "Browsable data does not mean simulation or online services are available.",
  "Arena Rank 系统概览": "Arena Rank overview",
  "目前不能查看真实赛季、排行榜或奖励；仍可查看已经确认的系统轮廓。完整页面需要正式赛季数据。":
    "Real seasons, leaderboards, and rewards are not available yet; the confirmed system outline remains viewable. A complete page requires real season data.",
  "输入核对": "Input verification",
  "核对本次输入": "Verify this input",
  "从编成研究台带入草稿后，这里会列出歌曲、难度、谱面摘要、卡牌基础值与输入标识，方便确认是否属于同一次验证。":
    "After importing a formation draft, this page lists the song, difficulty, chart summary, card base stats, and input identifier so they can be verified as one sample.",
  "本次输入": "This input",
  "为什么暂不计算": "Why calculation is unavailable",
  "角色、卡牌与游戏资料": "Characters, cards, and game data",
  "查找角色、卡牌与曲目资料": "Find characters, cards, and music data",
  "浏览角色与乐队、成员卡与留影、曲目与谱面，并继续进入剧情和游戏数据库。":
    "Browse characters and bands, member cards and snaps, tracks and charts, then continue to stories and the game database.",
  "非官方网站。资料来自当前可验证的游戏资源，名称、关系和可用范围可能继续调整。":
    "Unofficial website. The archive uses currently verifiable game resources; names, relations, and availability may continue to change.",
  "浏览角色与卡牌": "Browse characters and cards",
  "查找曲目": "Find music",
  "查询游戏数据": "Explore game data",
  "个角色": " characters",
  "张卡牌资料": " card records",
  "选择想查的内容，进入对应目录继续搜索和筛选。":
    "Choose what you want to find, then search and filter in its directory.",
  "查看近期加入的角色图、卡面和其他可预览资料。":
    "Browse recently added character art, card art, and other previewable materials.",
  "按角色、乐队或属性查找成员卡与留影，并查看原图、数值和技能资料。":
    "Find member cards and snaps by character, band, or attribute, then view their original art, stats, and skills.",
  "按角色或乐队查看人物资料与可用图片。":
    "Browse character information and available images by character or band.",
  "曲目分类": "Track category",
  "查看曲目、演唱关系和 BPM，比较各档难度，并进入谱面查看密度与轨道等谱面结构。 当前没有音频，只能查看曲目资料和站内分析。":
    "Browse tracks, vocal relations, and BPM, compare difficulty levels, and inspect chart density and lane structure. Audio is not available, so only track data and on-site analysis can be viewed.",
  "查看曲目、演唱关系和 BPM，比较各档难度，并进入谱面查看密度与轨道等谱面结构。":
    "Browse tracks, vocal relations, and BPM, compare difficulty levels, and inspect chart density and lane structure.",
  "当前没有音频，只能查看曲目资料和站内分析。":
    "Audio is not available, so only track data and on-site analysis can be viewed.",
  "曲目与谱面数据来自当前公开资料；完整音频尚未纳入站点。":
    "Track and chart data comes from the currently published archive; full audio is not included on the site.",
  "按章节、角色和场景查找主线、羁绊、主页场景与 Live 结算。 没有正文的条目仍可查看章节、登场角色、奖励和资源状态等基本资料。":
    "Find main stories, friendship stories, home scenes, and Live results by chapter, character, or scene. Entries without story text still show basic details such as chapter, featured characters, rewards, and resource status.",
  "按章节、角色和场景查找主线、羁绊、主页场景与 Live 结算。":
    "Find main stories, friendship stories, home scenes, and Live results by chapter, character, or scene.",
  "没有正文的条目仍可查看章节、登场角色、奖励和资源状态等基本资料。":
    "Entries without story text still show basic details such as chapter, featured characters, rewards, and resource status.",
  "主线剧情按章节和集数组织；每一集都会显示当前是否可以阅读。":
    "Main stories are organized by chapter and episode; each episode shows whether it can currently be read.",
  "查找技能、道具和乐队强化，也可以从卡牌反查它们的用途与条件。":
    "Find skills, items, and band boosts, or trace their uses and conditions back from a card.",
  "选择技能或道具查看详细效果、升级材料和关联卡牌。部分条件的含义尚未确认，页面会继续明确标出。":
    "Choose a skill or item to view detailed effects, upgrade materials, and related cards. Some condition meanings remain unconfirmed and stay explicitly marked.",
  "作品档案馆本期主视觉": "Current archive key visual",
  "保存舞台存在过的每一个瞬间":
    "Preserving every moment that existed on this stage",
  "从角色立绘与卡牌原图开始，建立一座可浏览、可检索、可追溯版本的作品资料档案。":
    "Beginning with character art and original card images, this archive makes the work browsable, searchable, and traceable across releases.",
  "非官方网站。当前内容来自测试版本资源归档，名称与关系仍在持续整理。":
    "Unofficial website. Current content comes from a test-release resource archive; names and relations remain under review.",
  "非官方网站。当前内容来自测试版本资源归档，名称与关系仍在持续整理。 未识别的名称和关系会明确标为待整理，不通过推测补齐。":
    "Unofficial website. Current content comes from a test-release resource archive; names and relations remain under review. Unidentified names and relations are explicitly marked as pending and never filled by guesswork.",
  "进入首期档案": "Enter the archive",
  "查看最近更新": "View recent updates",
  "从这里开始探索": "Start exploring here",
  "首页只负责作品与方向。搜索、筛选和技术信息留在各自的档案页面。":
    "The home page establishes the work and its direction. Search, filters, and technical details live in their dedicated archives.",
  "查看全部资源 →": "View all resources →",
  "已开放": "Available",
  "角色与卡牌": "Characters & Cards",
  "角色·养成资料": "Characters · Growth",
  "音乐·乐谱": "Music · Scores",
  "音乐·乐谱统计": "Music and scores overview",
  "← 返回音乐·乐谱": "← Back to Music · Scores",
  "音乐资料": "Music",
  "游戏数据库": "Game Database",
  "剧情档案": "Story Archive",
  "高清预览、来源信息与单文件下载":
    "High-resolution previews, provenance, and individual file downloads",
  "最近收录": "Recently cataloged",
  "所有展示均来自当前项目已解包的真实资源，不使用外部占位图。":
    "Every visual comes from real assets unpacked in this project; no external placeholders are used.",
  "查看版本记录 →": "View release notes →",
  "未识别的名称和关系会明确标为待整理，不通过推测补齐。":
    "Unidentified names and relations are explicitly marked as pending and are never filled by guesswork.",
  "卡牌资料": "Card Archive",
  "留影": "Snap",
  "成员卡与留影": "Member Cards & Snaps",
  "成员卡用于乐队编成，留影用于装备强化。两类资料使用独立模型，不把登场角色误写成装备限制。":
    "Member cards form bands; snaps are equipped for reinforcement. They use separate data models, and featured characters are never misrepresented as equipment restrictions.",
  "查看所属角色、乐队、稀有度、属性代码、最大数值与技能。":
    "Browse the owning character, band, rarity, attribute, maximum stats, and skills.",
  "查看登场角色、支援数值与技能；登场关系不代表装备限制。":
    "Browse featured characters, support stats, and skills. Featured-character relations do not imply equipment restrictions.",
  "成员卡和留影可以组合为玩家配装，但当前 Master 数据没有固定装备关系。未来配装查询会建立独立规则模型。":
    "Member cards and snaps can be combined in player loadouts, but the current Master data defines no fixed equipment relation. A future loadout query will use a separate rules model.",
  "成员卡目录入口预览": "Member-card directory preview",
  "留影目录入口预览": "Snap directory preview",
  "用于乐队编成的角色卡牌。所属角色、稀有度、属性代码、数值和技能均来自已解密 Master 数据。":
    "Character cards used to form bands. Character, rarity, attribute, stats, and skills all come from decrypted Master data.",
  "用于装备到成员卡的留影。这里记录画面中的登场角色、数值与技能，不把登场关系解释成装备限制。":
    "Snaps equipped to member cards. This archive records featured characters, stats, and skills without treating appearances as equipment restrictions.",
  "搜索卡牌标题、角色、乐队或 Master ID…":
    "Search title, character, band, or Master ID…",
  "搜索留影标题、登场角色或 Master ID…":
    "Search title, featured character, or Master ID…",
  "角色档案": "Character Archive",
  "按乐队浏览成员，查看角色档案、担当与关联卡牌。": "Browse members by band, with profiles, roles and related cards.",
  "曲目详情支持谱面分析与无音频模拟播放；当前资料版本尚未收录歌曲音频。": "Track details include chart analysis and silent playback. Song audio is not available in this release.",
  "Enhance 中的乐队物件会提升指定乐队的全队参数。这里与卡牌养成分开维护， 点击物件即可查看各等级的加成变化。": "Band items boost the band's stats. Select an item to inspect its bonuses at each level.",
  "角色名称、乐队、担当、生日和主题色来自已解密 Master 数据，并通过原始容器路径连接角色图片。":
    "Names, bands, roles, birthdays, and theme colors come from decrypted Master data and connect to character images through original container paths.",
  "搜索角色名称、别名或档案编号…":
    "Search character name, alias, or archive number…",
  "搜索曲目": "Search tracks",
  "15 以下": "15 or below",
  "26 以上": "26 or above",
  "139 以下": "139 or below",
  "180 以上": "180 or above",
  "游戏内顺序": "In-game order",
  "曲名": "Title",
  "开放时间": "Release date",
  "最高难度": "Highest difficulty",
  "EXPERT 音符数": "EXPERT note count",
  "当前条件没有匹配曲目": "No tracks match the current filters",
  "尝试清除一个筛选条件，或改用曲目编号搜索。":
    "Clear a filter or search by track number.",
  "显示全部曲目": "Show all tracks",
  "编号升序": "ID ascending",
  "编号降序": "ID descending",
  "当前条件没有匹配内容": "No content matches the current filters",
  "尝试清除一个筛选条件，或使用档案编号搜索。":
    "Clear a filter or search by archive number.",
  "全部类型": "All types",
  "加载漫画": "Loading comics",
  "表情贴纸": "Stickers",
  "剧情图片": "Story images",
  "全部角色": "All characters",
  "全部状态": "All states",
  "可预览": "Preview available",
  "仅元数据": "Metadata only",
  "资源详情": "Resource details",
  "资源详情 →": "Resource details →",
  "主线剧情": "Main story",
  "羁绊剧情": "Friendship stories",
  "主页场景": "Home scenes",
  "Live 结算": "Live results",
  "条": "records",
  "缺失": "Missing",
  "搜索标题、角色或媒体类型…":
    "Search title, character, or media type…",
  "没有匹配的角色媒体": "No character media matches",
  "可以清除角色或资源状态筛选，继续查看仅有元数据的条目。":
    "Clear the character or capability filter to include metadata-only records.",
  "显示全部": "Show all",
  "类别": "Kind",
  "全部技能": "All skills",
  "支援技能": "Support Skill",
  "激奏技能": "Gekisou Skill",
  "激奏支援": "Gekisou Support",
  "效果": "Effect",
  "全部效果": "All effects",
  "目标": "Target",
  "全部目标": "All targets",
  "条件": "Conditions",
  "有条件分支": "Has conditional branches",
  "无条件分支": "No conditional branches",
  "解释状态": "Interpretation",
  "已解释": "Identified",
  "部分解释": "Partial",
  "技能编号": "Skill ID",
  "技能名称": "Skill name",
  "关联卡牌数": "Related card count",
  "类型": "Type",
  "用途": "Usage",
  "全部用途": "All usages",
  "技能升级": "Skill level",
  "成员卡 Rank": "Member Card Rank",
  "成员卡觉醒": "Member Card Awakening",
  "留影 Rank": "Snap Rank",
  "图标": "Icon",
  "已有图标": "Icon available",
  "缺少图标": "Missing icon",
  "状态": "Status",
  "当前有效": "Currently active",
  "未开放或已结束": "Not started or ended",
  "游戏顺序": "In-game order",
  "道具编号": "Item ID",
  "道具名称": "Item name",
  "当前条件没有匹配记录": "No records match the current filters",
  "清除一个筛选条件，或改用 Master 编号搜索。":
    "Clear a filter or search by Master ID.",
  "页面不存在": "Page not found",
  "这份档案 尚未入库": "This archive is not available",
  "这份档案": "This archive",
  "尚未入库": "is not available",
  "地址可能来自旧版本，或对应模块还没有公开。可以返回首页，或从资源中心重新查找。":
    "The address may belong to an older release, or the module may not be public yet. Return home or search again from the Resource Center.",
  "返回首页": "Return home",
  "打开资源中心": "Open Resource Center",
  "图片查看工具": "Image viewer tools",
  "角色": "Character",
  "放大": "Zoom",
  "全屏": "Fullscreen",
  "背景": "Background",
  "资源类型": "Resource type",
  "角色素材": "Character asset",
  "卡面": "Card art",
  "横幅": "Banner",
  "封面": "Cover",
  "标识": "Logo",
  "道具图标": "Item icon",
  "技能图标": "Skill icon",
  "归档状态": "Archive status",
  "待归档": "Pending archive",
  "按技术类型查看当前发布集。每个资源都有预览、来源、尺寸和哈希，并按发布策略提供单文件下载。":
    "Browse the current release by technical type. Every resource includes a preview, provenance, dimensions, and hash, with individual downloads provided according to publication policy.",
  "角色媒体馆": "Character Media Archive",
  "按角色、乐队和媒体类型查看加载漫画、表情贴纸与剧情图片。":
    "Browse loading comics, stickers, and story images by character, band, and media type.",
  "进入媒体馆 ↗": "Open media archive ↗",
  "搜索资源名、来源路径或档案编号…":
    "Search resource name, source path, or archive ID…",
  "技术来源已经确认，业务归属按当前归档状态显示。":
    "Technical provenance is confirmed; domain ownership follows the current archive status.",
  "曲目归属：": "Track relation:",
  "对象 ID": "Object ID",
  "分类置信度": "Classification confidence",
  "单文件下载 · 未提供整包分发":
    "Individual download · no complete package distribution",
  "该资源仅供站内预览，不提供源文件下载。":
    "This resource is available for in-site preview only; the source file is not downloadable.",
  "归档证据": "Archive Evidence",
  "以下路径仅用于追溯本地提取来源，不作为公开下载路径。":
    "These paths document the local extraction source and are not public download paths.",
  "返回资源中心 →": "Back to Resource Center →",
  "来源文件": "Source file",
  "来源 Bundle": "Source bundle",
  "原始容器路径": "Original container path",
  "汇总加载漫画、表情贴纸与剧情图片。真实文件可进入资源详情； 当前包只有引用关系的条目仍然保留，但不会伪造预览或下载入口。":
    "Collects loading comics, stickers, and story images. Real files link to resource details; reference-only entries remain visible without fabricated previews or downloads.",
  "未指定角色": "No character specified",
  "放大查看": "Open larger preview",
  "放大查看 ↗": "Open larger preview ↗",
  "图片预览": "Image preview",
  "关闭图片预览": "Close image preview",
  "规则如何连接到 每一张卡": "How rules connect to every card",
  "规则如何连接到": "How rules connect to",
  "每一张卡": "every card",
  "从技能、条件、成长曲线和材料关系，查看游戏数据的完整定义与卡牌投影。":
    "Explore complete game-data definitions and card projections through skills, conditions, growth curves, and material relations.",
  "数据库收录统计": "Database archive statistics",
  "从规则进入，或从卡牌反查": "Enter through rules or trace back from cards",
  "数据库维护定义；卡牌页只消费自动生成的视图。":
    "The database owns definitions; card pages only consume generated views.",
  "技能、效果、条件与目标": "Skills, effects, conditions, and targets",
  "技能索引": "Skill Index",
  "五类技能的全部等级、条件分支、目标和关联卡牌。":
    "Every level, conditional branch, target, and related card across five skill types.",
  "成员卡与留影分开建模，保留倍率和 Master 原始值。":
    "Member cards and snaps use separate models while preserving rates and raw Master values.",
  "材料、用途与反向关系": "Materials, usages, and reverse relations",
  "道具索引": "Item Index",
  "查看道具被哪些技能等级、Rank 或觉醒阶段使用。":
    "See which skill levels, ranks, or awakening stages use each item.",
  "乐队强化": "Band Enhancement",
  "查看 Enhance 物件、所属乐队与每一级的全队参数加成。":
    "Browse Enhance objects, their bands, and whole-band stat bonuses at every level.",
  "已完整解释": "Fully interpreted",
  "保留原始证据": "Raw evidence retained",
  "“部分解释”表示原始效果和关系完整保留，但条件组合或枚举仍缺少客户端语义证据。":
    "“Partial” means the original effects and relations are retained, while condition combinations or enums still lack client-side semantic evidence.",
  "该道具暂无说明文本。": "No description is available for this item.",
  "卡牌用途": "Card usages",
  "道具字段": "Item fields",
  "资源来源": "Resource source",
  "卡牌系统用途": "Card-system usages",
  "当前卡牌、技能和养成数据没有引用该道具。":
    "No current card, skill, or growth data references this item.",
  "这里展示“被哪些阶段要求”，不代表道具获取途径。任务、奖励、商店和兑换将在后续模块接入。":
    "This records which stages require the item, not how it is obtained. Missions, rewards, shops, and exchanges will be connected in later modules.",
  "库存显示组": "Inventory display group",
  "数值": "Value",
  "显示顺序": "Display order",
  "结束时间": "End time",
  "未限制": "No restriction",
  "图标与来源": "Icon & Source",
  "逻辑路径：": "Logical path:",
  "查看图标资源技术详情 →": "View icon technical details →",
  "当前发布资源中未找到对应图标。":
    "No matching icon was found in the current release.",
  "该技能没有等级效果记录。": "This skill has no level-effect records.",
  "等级效果": "Level effects",
  "升级材料": "Upgrade materials",
  "关联卡牌": "Related cards",
  "原始证据": "Raw evidence",
  "等级与效果分支": "Levels & Effect Branches",
  "值": "Value",
  "持续": "Duration",
  "目标 / 条件": "Target / Condition",
  "包含条件分支": "Contains conditional branches",
  "默认目标": "Default target",
  "当前关联卡牌没有提供该技能的升级材料组。":
    "Related cards provide no upgrade-material group for this skill.",
  "解释状态与来源": "Interpretation & Source",
  "描述模板由受限解释器生成。未识别的条件组合不会执行或猜测，而是保留为“指定条件”。":
    "Descriptions are generated by a constrained interpreter. Unidentified condition combinations are not executed or guessed and remain explicit placeholders.",
  "查看 Master 描述模板": "View Master description template"
  ,"← 返回音乐资料库": "← Back to Music"
  ,"峰值": "Peak"
  ,"谱面分析工作台": "Chart Analysis Workbench"
  ,"在固定时间比例的 24 单位轨道中滚动查看整首谱面。":
    "Scroll through the full chart on a 24-unit timeline with fixed temporal scale."
  ,"平均密度": "Average density"
  ,"峰值 / 秒": "Peak / second"
  ,"技能次数": "Skill activations"
  ,"激奏类型": "Gekisou types"
  ,"激奏区间": "Gekisou section"
  ,"谱面难度": "Chart difficulty"
  ,"第 1 激奏": "Section 1"
  ,"第 2 激奏": "Section 2"
  ,"第 3 激奏": "Section 3"
  ,"播放与模拟": "Playback & simulation"
  ,"音符与密度": "Notes & density"
  ,"Combo 奖励": "Combo rewards"
  ,"正在读取标准化谱面…": "Loading normalized chart…"
  ,"可视化数据读取失败。难度与官方摘要仍可使用，请刷新页面后重试。":
    "Visualization data could not be loaded. Difficulty and official summaries remain available; refresh to retry."
  ,"全曲密度": "Full-track density"
  ,"← 上一屏": "← Previous screen"
  ,"下一屏 →": "Next screen →"
  ,"显示音符类型": "Visible note types"
  ,"事件": "Events"
  ,"当前浏览器不支持 Canvas。请使用上方密度图和统计摘要查看谱面。":
    "This browser does not support Canvas. Use the density chart and summary above instead."
  ,"选择一个音符": "Select a note"
  ,"点击轨道中的 Tap、Flick 或 Long 节点，查看时间、位置和当前事件。":
    "Select a Tap, Flick, or Long note to inspect its time, position, and active events."
  ,"关联与来源": "Relations & Provenance"
  ,"曲目 Master ID": "Track Master ID"
  ,"四档已解析 · 站内展示": "Four difficulties parsed · in-site display"
  ,"可播放 · 不可下载": "Playable · no downloads"
  ,"把曲目放回": "Put each track back"
  ,"谱面与演唱者": "charts and vocalists"
  ,"之间": "between its"
  ,"从曲名、乐队与创作者出发，比较四档难度，并进入每一份谱面的密度和轨道结构。 音频尚未入库，当前只开放经过验证的数据与站内分析。":
    "Start from title, band, and creators; compare four difficulties and inspect each chart’s density and lane structure. Audio is not yet archived, so only verified data and in-site analysis are available."
  ,"从曲名、乐队与创作者出发，比较四档难度，并进入每一份谱面的密度和轨道结构。 音频尚未入库，当前只开放经过验证的数据与in-site analysis。":
    "Start from title, band, and creators; compare four difficulties and inspect each chart’s density and lane structure. Audio is not yet archived, so only verified data and in-site analysis are available."
  ,"已收录曲目": "Archived tracks"
  ,"正式谱面": "Parsed charts"
  ,"把章节": "Put each chapter"
  ,"放回": "back between"
  ,"脚本与场景": "scripts and scenes"
  ,"章节、羁绊、主页场景与 Live 结算都来自 Master 元数据。脚本与音频未 完整入库时，页面只展示档案页和当前资源覆盖，不渲染空阅读器或空 播放器。":
    "Chapters, friendship stories, home scenes, and Live results all come from Master metadata. When scripts or audio are incomplete, the site shows archive records and current coverage without rendering empty readers or players."
  ,"主线章节": "Main chapters"
  ,"主线集数": "Main episodes"
  ,"羁绊 / 场景 / Live": "Friendship / Scenes / Live"
  ,"已开放阅读": "Readable"
  ,"主线剧情按章节和集数组织，集数脚本能力由 ADV 适配器逐集决定。":
    "The main story is organized by chapter and episode; the ADV adapter determines script capability per episode."
  ,"集数": "Episodes"
  ,"登场角色": "Featured characters"
  ,"主题音乐": "Theme music"
  ,"剧情目录": "Story Directory"
  ,"主线、羁绊、主页场景与 Live 结算共用同一筛选条件，便于跳转与剧本检索。":
    "Main, friendship, home, and Live-result entries share filters for easier navigation and script lookup."
  ,"仅查看主页场景与 Live 对话 →": "View home scenes and Live dialogue only →"
  ,"剧情类型": "Story type"
  ,"地点": "Location"
  ,"资源能力": "Resource capability"
  ,"集数顺序": "Episode order"
  ,"标题": "Title"
  ,"章节": "Chapter"
  ,"脚本": "Script"
  ,"查看档案 →": "View archive →"
  ,"角色组合": "Character combination"
  ,"当前脚本覆盖": "Current Script Coverage"
  ,"页面所有脚本状态来自": "Every script status comes from"
  ,"的判定。": "."
  ,"当 ADV Text 分片存在并被识别为命令流时，剧情档案页开放阅读器。当前包没有这种集数。":
    "The reader opens when ADV Text shards exist and are recognized as a command stream. The current package contains no such episodes."
  ,"主数据完整，脚本文件未在当前解包中检出。页面展示章节、奖励和来源，不渲染阅读器。":
    "Master data is complete, but no script file was found in the current extraction. The page shows chapters, rewards, and provenance without a reader."
  ,"当前剧情类型": "Current story types"
  ,"← 返回剧情档案": "← Back to Story Archive"
  ,"切换简介遮罩": "Toggle summary overlay"
  ,"起止时间": "Time range"
  ,"章节集数": "Chapter episodes"
  ,"每集脚本能力由 ADV 适配器按 shard 状态分别决定；缺失脚本不会生成空阅读器。":
    "The ADV adapter determines each episode’s script capability from shard state; missing scripts never produce empty readers."
  ,"章节、主线集数、乐队、角色与音乐的来源由":
    "Chapter, episode, band, character, and music relations are traced directly through"
  ,"与": "and"
  ,"直接追溯。": "."
  ,"章节来源": "Chapter source"
  ,"集数来源": "Episode source"
  ,"横幅资源": "Banner resource"
  ,"章节图资源": "Chapter image resource"
  ,"ADV 编号": "ADV ID"
  ,"剧本资源": "Script resource"
  ,"主数据完整，但当前解包中未检出 Text 分片。重新解包新版本后，无需手工改关系即可自动开放阅读器。":
    "Master data is complete, but no Text shard was found in the current extraction. A newly unpacked release can open the reader automatically without manual relation edits."
  ,"分片状态": "Shard Status"
  ,"分片": "Shard"
  ,"解锁后获得剧情奖励组": "Unlocking grants story reward group"
  ,"，详见": "; see"
  ,"数据库 · 道具": "Database · Items"
  ,"主表": "Master table"
  ,"主表 ID": "Master-table ID"
  ,"剧本文件": "Script file"
  ,"已是第一章首集": "First episode of the first chapter"
  ,"已是本章末集": "Last episode of this chapter"
  ,"← 上一集": "← Previous episode"
  ,"下一集 →": "Next episode →"
  ,"卡牌功能图标": "Card UI icon"
  ,"乐队标识": "Band logo"
  ,"其他": "Other"
  ,"Live 技能": "Live Skill"
  ,"所属成员卡": "Member cards"
  ,"登场留影": "Featured snaps"
  ,"参与曲目": "Vocal tracks"
  ,"查看登场留影": "View featured snaps"
  ,"角色资料抽屉": "Character Detail Drawers"
  ,"核心页面保持简洁；服装、语音、台词与关联媒体在需要时展开。":
    "The core page stays compact; costumes, voices, home lines, and related media expand on demand."
  ,"服装": "Costumes"
  ,"Live2D 路径与关联": "Live2D paths and relations"
  ,"角色语音": "Character voices"
  ,"主页台词": "Home lines"
  ,"羁绊": "Friendships"
  ,"固定组合与对话": "Fixed combinations and dialogue"
  ,"图片媒体": "Image media"
  ,"漫画 / 贴纸 / 剧情图": "Comics / Stickers / Story images"
  ,"当前包可以确认服装编号与 Live2D 模型路径；没有可验证预览时不生成替代图。":
    "The current package confirms costume IDs and Live2D model paths. No substitute image is generated when a preview cannot be verified."
  ,"默认服装": "Default costume"
  ,"系统语音按分类检索，点击播放时才读取本地完整音频。":
    "System voices are searchable by category; local full audio loads only when playback is requested."
  ,"台词": "Line"
  ,"语音分类": "Voice category"
  ,"等级提升": "Level Up"
  ,"分数评级": "Score Rating"
  ,"对战第一": "Battle First"
  ,"对战优势": "Battle Advantage"
  ,"对战劣势": "Battle Disadvantage"
  ,"特训": "Training"
  ,"技能提升": "Skill Up"
  ,"Live 通关": "Live Clear"
  ,"当前条件没有匹配语音。": "No voices match the current filters."
  ,"同时保留动作、表情、服装和角色等级条件，便于核对游戏内触发方式。":
    "Motion, expression, costume, and character-rank conditions are retained to verify in-game triggers."
  ,"动作": "Motion"
  ,"表情": "Expression"
  ,"解锁": "Unlock"
  ,"展示固定角色组合、等级经验节点与已解包的 Live 固定组合台词。":
    "Shows fixed character combinations, level/EXP nodes, and unpacked fixed-combination Live dialogue."
  ,"这里只放快速索引；筛选、来源与原始文件信息集中在角色媒体馆。":
    "This is a quick index; filters, provenance, and original-file details live in the Character Media Archive."
  ,"打开角色媒体馆，继续筛选全部图片 →":
    "Open the Character Media Archive to filter all images →"
  ,"该角色的成员卡": "This character’s member cards"
  ,"以下成员卡通过 MasterMemberCard.characterID 固定属于该角色。":
    "These member cards are assigned to this character by MasterMemberCard.characterID."
  ,"查看全部成员卡 →": "View all member cards →"
  ,"该角色登场的留影": "Snaps featuring this character"
  ,"登场关系来自 MasterSupportCard.characterIDs，不代表装备限制。":
    "Featured-character relations come from MasterSupportCard.characterIDs and do not imply equipment restrictions."
  ,"查看全部留影 →": "View all snaps →"
  ,"该角色参与演唱的曲目": "Tracks sung by this character"
  ,"演唱关系来自 MasterLiveMusic.vocalCharacterIDs。":
    "Vocal relations come from MasterLiveMusic.vocalCharacterIDs."
  ,"在音乐资料库查看 →": "View in Music →"
  ,"等级、Rank、觉醒和阶段材料分别保留成员卡与留影的真实结构。":
    "Level, Rank, Awakening, and staged materials preserve the distinct real structures of member cards and snaps."
  ,"计算边界": "Calculation Boundary"
  ,"倍率按 10000 比例尺显示；经验值和 Rank 要求数量保留 Master 语义，不在未验证公式下计算最终战力或材料缺口。":
    "Rates use a 10,000-point scale. EXP and Rank requirements retain Master semantics; final power and material shortfalls are not calculated with unverified formulas."
  ,"成员卡成长": "Member Card Growth"
  ,"留影成长": "Snap Growth"
  ,"表现倍率": "Performance rate"
  ,"技巧倍率": "Technique rate"
  ,"视觉倍率": "Visual rate"
  ,"等级上限": "Level cap"
  ,"要求数量": "Required count"
  ,"按觉醒规则": "By awakening rules"
  ,"Enhance 中的乐队物件会提升指定乐队的全队参数。这里与卡牌养成分开维护， 点击物件即可查看 Lv.1–10 的真实变化。":
    "Band objects in Enhance raise whole-band stats for a specified band. They are maintained separately from card growth; select an object to inspect its real Lv.1–10 progression."
  ,"等级与加成来自 Master 数据。当前包仅保留资源组编号，没有可验证的升级材料明细， 因此不会把未知消耗显示为零或自行推测材料。":
    "Levels and bonuses come from Master data. The current package retains only resource-group IDs and has no verifiable upgrade-material details, so unknown costs are never shown as zero or guessed."
  ,"每件最高 Lv.10": "maximum Lv.10 each"
  ,"查看 10 级变化": "View 10 levels"
  ,"查看等级数据": "View level data"
  ,"当前加成": "Current bonus"
  ,"玩家等级门槛：Rank 1": "Player-rank requirement: Rank 1"
  ,"当前资源包未提供可验证的升级消耗明细。":
    "The current resource package provides no verifiable upgrade-cost details."
  ,"数据已完整解释": "Data fully interpreted"
  ,"按类别、效果、目标和条件筛选，并反查使用该技能的卡牌。":
    "Filter by kind, effect, target, and conditions, then trace back to cards using each skill."
  ,"查看定义 →": "View definition →"
  ,"从材料用途反查技能升级、Rank、觉醒和关联卡牌。":
    "Trace skill upgrades, Rank, Awakening, and related cards from material usages."
  ,"当前卡牌系统未引用": "Not referenced by the current card system"
  ,"查看用途 →": "View usages →"
  ,"图鉴": "Archive"
  ,"角色、乐队、成员卡和留影已经接入 Master 数据，并保留来源追溯与原图下载。":
    "Characters, bands, member cards, and snaps are connected to Master data with provenance and original-image downloads retained."
  ,"浏览已提取的角色视觉对象、来源版本和整理状态。":
    "Browse extracted character visuals, source releases, and archive status."
  ,"分别浏览用于编成的成员卡与用于装备的留影。":
    "Browse member cards used in formation and snaps used as equipment."
  ,"业务关系来自解密 Master 主键与 Unity 原始容器路径。无法验证的内容仍留在资源中心，不按文件顺序猜测。":
    "Domain relations come from decrypted Master keys and original Unity container paths. Unverifiable content remains in the Resource Center and is never inferred from file order."
  ,"清空本组": "Clear this group"
  ,"全部清空": "Clear all"
  ,"搜索与筛选切换": "Search and filter"
  ,"当前": "Current"
  ,"当前条件没有匹配项。请移除一个筛选条件。":
    "No entries match these filters. Remove one filter to continue."
  ,"演唱乐队": "Performing band"
  ,"演唱角色": "Vocal character"
  ,"歌曲属性": "Track attribute"
  ,"客户端分类": "Client category"
  ,"Best Music 标签": "Best Music tag"
  ,"关联乐队": "Related band"
  ,"画面登场角色": "Featured characters"
  ,"单人演奏与难度": "Solo Live & Difficulties"
  ,"分数达成奖励": "Score milestone rewards"
  ,"分数奖励": "Score rewards"
  ,"分数奖励、Combo 奖励与谱面指标均由本曲 Master 和正式谱面生成。":
    "Score rewards, Combo rewards, and chart metrics are generated from this track's Master data and formal charts."
  ,"上一项": "Previous"
  ,"下一项": "Next"
  ,"High Score Rating 规划器": "High Score Rating Planner"
  ,"无需逐曲录入，用一个当前 Rating 规划总合或乐队 High Score Rating 目标。":
    "Plan a total or band High Score Rating target with one current value and no per-chart entry."
  ,"不用录入每首歌， 先看离目标还有多远。":
    "No per-song entry. See the distance to your target."
  ,"不用录入每首歌，": "No per-song entry."
  ,"先看离目标还有多远。": "See the distance to your target."
  ,"选择总合或乐队档位；当前 Rating 可以留空，也可以只填一个数字来计算差值与改善规模。":
    "Choose a total or band tier. Leave the current Rating empty, or enter one number to calculate the gap and improvement scale."
  ,"计分谱面": "Scoring charts"
  ,"档位数量": "Tier count"
  ,"原始分数换算": "Raw-score conversion"
  ,"不推测": "Not inferred"
  ,"这里规划的是 High Score Rate 合计，不是原始打歌分数。":
    "This planner works with the High Score Rate total, not raw play scores."
  ,"选择你的目标": "Choose your target"
  ,"Rating 计算范围": "Rating scope"
  ,"总合 Rating": "Total Rating"
  ,"最高 20 张谱面合计": "Sum of the top 20 charts"
  ,"乐队 Rating": "Band Rating"
  ,"当前版本使用通用门槛": "The current release uses common thresholds"
  ,"当前 Rating 选填，只保存在本机": "Current Rating Optional, stored only on this device"
  ,"当前 Rating": "Current Rating"
  ,"选填，只保存在本机": "Optional, stored only on this device"
  ,"留空只查看目标": "Leave empty for target-only mode"
  ,"只接受非负整数；不会写进分享链接。":
    "Only non-negative integers are accepted. This value is never added to the share URL."
  ,"请输入非负整数。": "Enter a non-negative integer."
  ,"复制目标链接": "Copy target link"
  ,"清除当前值": "Clear current value"
  ,"目标档位": "Target tier"
  ,"当前档位": "Current tier"
  ,"尚未填写": "Not entered"
  ,"目标查看模式": "Target-only mode"
  ,"距离目标": "Gap to target"
  ,"填写当前 Rating 后计算": "Enter a current Rating to calculate"
  ,"目标均摊": "Target average"
  ,"点击档位设为目标": "Select a tier as the target"
  ,"已跨过、当前、目标三个状态会分别标记。":
    "Passed, current, and target tiers are marked separately."
  ,"把同一个差值换成三种改善规模": "View the same gap at three improvement scales"
  ,"均匀补足全部计分谱面": "Spread across all scoring charts"
  ,"集中改善 10 张": "Improve 10 charts"
  ,"集中改善 5 张": "Improve 5 charts"
  ,"每张 High Score Rate 差额": "High Score Rate gap per chart"
  ,"以上只是 High Score Rate 总差额的数学分摊，不是原始打歌分数，也不是个性化谱面推荐。":
    "These are mathematical splits of the total High Score Rate gap, not raw-score targets or personalized chart recommendations."
  ,"阶段奖励": "Tier reward"
  ,"奖励是目标详情，不参与 Rating 计算。":
    "Rewards describe the target tier and do not affect the Rating calculation."
  ,"该阶段没有奖励记录": "No reward is recorded for this tier"
  ,"目标链接已复制": "Target link copied"
  ,"复制失败，请从地址栏复制": "Copy failed; copy the URL from the address bar"
  ,"目标已达成": "Target achieved"
  ,"High Score Rate 差额": "High Score Rate gap"
  ,"スター": "Star"
  ,"系统轮廓已经存在， 赛季服务尚未开放。":
    "The system outline exists. The season service is not open."
  ,"系统轮廓已经存在，": "The system outline exists."
  ,"赛季服务尚未开放。": "The season service is not open."
  ,"Arena 是独立收录的周期性联网排位。当前客户端与撃奏高度关联，但没有足够证据把它永久定义为撃奏专属。":
    "Arena is archived as an independent seasonal online ranking system. The current client closely relates it to Gekisou, but the evidence does not establish permanent exclusivity."
  ,"客户端结构": "Client structure"
  ,"已确认": "Confirmed"
  ,"服务器功能": "Server service"
  ,"未开放": "Unavailable"
  ,"当前赛季数据": "Current season data"
  ,"不可用": "Unavailable"
  ,"客户端已经为这些能力预留结构": "The client contains structures for these capabilities"
  ,"这里确认的是结构存在，不代表服务器已经提供段位阈值、匹配、榜单或奖励内容。":
    "This confirms structure only; it does not mean the server provides rank thresholds, matchmaking, leaderboards, or rewards."
  ,"联赛点": "League points"
  ,"大师点与大师段位": "Master points and Master rank"
  ,"连胜": "Winning streak"
  ,"赛季开始、结束与结算": "Season start, end, and settlement"
  ,"当前与上赛季排行榜": "Current and previous season leaderboards"
  ,"Ranking、Promotion、Season 奖励": "Ranking, Promotion, and Season rewards"
  ,"每日奖励": "Daily rewards"
  ,"赛季通行证": "Season pass"
  ,"Arena 兑换入口": "Arena exchange"
  ,"编队适性": "Formation suitability"
  ,"支援道具": "Support items"
  ,"流行度与编成趋势": "Popularity and formation trends"
  ,"匹配超时": "Matchmaking timeout"
  ,"断线惩罚": "Disconnect penalty"
  ,"赛季区域": "Season areas"
  ,"Arena 服务尚未开放，当前发布版本没有可验证的赛季、榜单或奖励实例。":
    "The Arena service is not open. This release has no verifiable season, leaderboard, or reward instance."
  ,"排行榜": "Leaderboard"
  ,"晋级奖励": "Promotion rewards"
  ,"赛季奖励": "Season rewards"
  ,"往期赛季": "Past seasons"
  ,"等待真实赛季数据": "Waiting for real season data"
  ,"排名、玩家、Rating、联赛点或大师点": "Rank, player, Rating, league points, or master points"
  ,"段位条件、奖励定义与领取状态": "Rank conditions, reward definitions, and claim status"
  ,"赛季条件、奖励组与结算状态": "Season conditions, reward groups, and settlement status"
  ,"稳定赛季 ID、起止时间与最终榜单": "Stable season ID, start/end time, and final leaderboard"
  ,"它和撃奏、Battle Live 的关系": "How it relates to Gekisou and Battle Live"
  ,"当前版本与撃奏高度关联": "Closely related to Gekisou in the current release"
  ,"客户端命名、入口、玩家档案字段与编队适性均指向撃奏，但证据不足以定义为永久独占关系。":
    "Client naming, entry points, player-profile fields, and formation suitability all point to Gekisou, but do not establish a permanent exclusive relationship."
  ,"复用部分 Battle Live 运行资源": "Reuses some Battle Live runtime resources"
  ,"资源证据包含 BattleLiveArenaPenLight。":
    "Resource evidence includes BattleLiveArenaPenLight."
  ,"实际段位与排行榜依赖赛季服务": "Actual ranks and leaderboards depend on the season service"
  ,"当前发布版本没有完整的赛季、榜单、阈值或奖励实例。":
    "This release has no complete season, leaderboard, threshold, or reward instance."
  ,"当前证据": "Current evidence"
  ,"Arena 文案": "Arena text records"
  ,"匹配分桶": "Matchmaking buckets"
  ,"排名加成": "Ranking bonuses"
  ,"功能开关": "Feature flag"
  ,"关闭": "Off"
  ,"开启": "On"
  ,"客户端符号": "Client symbols"
  ,"缺失的赛季字段": "Missing season fields"
  ,"客户端结构确认": "Client structure confirmed"
  ,"Master 确认": "Master confirmed"
  ,"资源确认": "Resource confirmed"
  ,"服务器数据缺失": "Server data missing"
  ,"当前版本与撃奏高度关联，但 Arena 作为周期性联网排位独立收录，不定义为撃奏永久独占子模式。":
    "The current release closely relates Arena to Gekisou, but Arena is archived independently as a seasonal online ranking system, not as a permanently exclusive sub-mode."
  ,"查看 Arena 系统 →": "View Arena system →"
  ,"周期性联网排位有独立页面；当前客户端结构已确认，赛季实例仍不可用。":
    "The seasonal online ranking system has its own page. Client structure is confirmed, while season instances remain unavailable."
  ,"查看 Arena →": "View Arena →"
  ,"← 返回游戏模式": "← Back to Game Modes"
  ,"当前收录 Battle Live、撃奏与 Arena Rank。离线档案来自本地 Master；Arena 会单独标明客户端结构与服务器开放状态。":
    "The archive currently covers Battle Live, Gekisou, and Arena Rank. Offline records come from local Master data; Arena separates client structure from server availability."
  ,"周期性的联网排位系统。客户端结构已确认；当前没有可验证的赛季、排行榜或奖励实例。":
    "A seasonal online ranking system. Client structure is confirmed; no verifiable season, leaderboard, or reward instance is currently available."
  ,"能力结构": "Capability structures"
  ,"当前赛季": "Current season"
  ,"联网服务": "Online service"
  ,"查看系统档案 →": "View system archive →"
  ,"编成研究台与 High Score Rating 目标规划器已经可用；歌曲计算和最佳化仍等待计分规则通过样本对账。":
    "The team workbench and High Score Rating target planner are available. Song calculation and optimization still await score-rule reconciliation."
  ,"只填一个当前 Rating，或直接选择目标档位，查看 Top 20 差值和三种改善规模。":
    "Enter one current Rating or select a target tier to see the Top 20 gap at three improvement scales."
  ,"打开目标规划器 →": "Open target planner →"
  ,"选择留影": "Choose snap"
  ,"留影不属于当前 Release": "Snap does not belong to the current release"
  ,"编队完整 · 5 张成员卡 + 5 张留影": "Formation complete · 5 member cards + 5 snaps"
  ,"一个编队固定为 5 张成员卡与 5 张留影。当前可用：资料选择、基础值合计、技能摘要、歌曲草稿、URL 与 JSON 保存。":
    "A formation always contains 5 member cards and 5 snaps. Available now: selection, base-stat totals, skill summaries, track drafts, and URL or JSON saving."
  ,"每个位置包含 1 张成员卡和 1 张留影；重复限制、装备限制和最终综合力公式仍保持未验证。":
    "Each position contains 1 member card and 1 snap. Duplicate limits, equipment restrictions, and the final power formula remain unverified."
  ,"每个位置选择 1 张成员卡和 1 张留影，共计 5 + 5 份资料。":
    "Choose 1 member card and 1 snap for every position, for 5 + 5 records total."
};

export const englishFragmentTranslations: Array<[string, string]> = [
  [" 个主线章节", " main chapters"],
  [" 条剧情入口", " story entries"],
  [" 条可阅读", " readable"],
  [" 个角色", " characters"],
  [" 张成员卡", " member cards"],
  [" 张留影", " snaps"],
  [" 首曲目", " tracks"],
  [" 份谱面", " charts"],
  [" 项技能", " skills"],
  [" 种道具", " items"],
  [" 套养成规则", " growth profiles"],
  [" 个角色档案", " character records"],
  [" 条记录", " records"],
  [" 项要求", " requirements"],
  ["属性代码 ", "Attribute "],
  ["稀有度 ", "Rarity "],
  ["搜索", "Search "],
  ["显示全部", "Show all "],
  ["站内分析", "in-site analysis"]
  ,["卡面 · ", "Card art · "]
  ,["背景 · ", "Background · "]
  ,["横幅 · ", "Banner · "]
  ,[" · 留影", " · Snap"]
  ,[" · 成员卡", " · Member card"]
  ,["。该卡用于乐队编成；下方直接显示官方最大数值与全部已关联技能。", ". This card is used in band formation; official maximum stats and every linked skill appear below."]
  ,["。该留影用于装备到成员卡；登场角色只表示画面内容关系，不代表装备限制。", ". This snap is equipped to a member card. Featured characters describe the scene and do not imply equipment restrictions."]
  ,[" 个等级", " levels"]
  ,[" 张关联卡牌", " related cards"]
  ,["目标类型 ", "Target type "]
  ,["阶段 ", "Stage "]
  ,["要求 × ", "Required × "]
  ,[" 个公开资源", " public resources"]
  ,["时长 ", "Duration "]
  ,[" 秒", " sec"]
  ,["角色 ID ", "Character ID "]
  ,[" · 曲目封面", " · Track cover"]
  ,[" · 角色立绘", " · Character art"]
  ,[" · 角色缩略图", " · Character thumbnail"]
  ,["技能升级 · ", "Skill Level · "]
  ,[" 条可播放", " playable"]
  ,[" records可播放", " playable"]
  ,["的服装", "’s costumes"]
  ,["的角色语音", "’s character voices"]
  ,["的主页台词", "’s home lines"]
  ,["的角色羁绊", "’s friendships"]
  ,["的图片媒体", "’s image media"]
  ,["服装 #", "Costume #"]
  ,["服装 ", "Costume "]
  ,["模型暂不支持", "model unsupported"]
  ,["角色 Rank ", "Character Rank "]
  ,[" 张卡", " cards"]
  ,["类型 ", "Type "]
  ,[" 章节 / ", " chapters / "]
  ,["曲目 ", "Track "]
  ,["角色 ", "Character "]
  ,["地点 ", "Location "]
  ,["← 返回 ", "← Back to "]
  ,[" · 共 ", " · "]
  ,[" 条", " records"]
  ,["切换成员卡", "Switch member card"]
  ,["切换留影", "Switch snap"]
  ,["切换角色", "Switch character"]
  ,["切换歌曲", "Switch track"]
  ,["搜索成员卡名称或编号", "Search member-card name or ID"]
  ,["搜索留影名称或编号", "Search snap name or ID"]
  ,["搜索角色名称或编号", "Search character name or ID"]
  ,["搜索歌曲名称或编号", "Search track name or ID"]
  ,["奖励 ID ", "Reward ID "]
  ,["未来承载：", "Future fields: "]
  ,["每张 × ", "Per chart × "]
  ,["目标 Rating", "Target Rating"]
  ,["スター", "Star"]
  ,["排名、玩家、Rating、联赛点或大师点", "Rank, player, Rating, league points, or master points"]
  ,["段位条件、奖励定义与领取状态", "Rank conditions, reward definitions, and claim status"]
  ,["赛季条件、奖励组与结算状态", "Season conditions, reward groups, and settlement status"]
  ,["稳定赛季 ID、起止时间与最终榜单", "Stable season ID, start/end time, and final leaderboard"]
];
