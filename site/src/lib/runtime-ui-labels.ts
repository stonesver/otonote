type TeamIssueCode =
  | "invalid_draft"
  | "unsupported_schema"
  | "unknown_rule_set"
  | "invalid_slots"
  | "invalid_slot"
  | "unknown_member_card"
  | "unknown_support_card"
  | "unknown_song"
  | "invalid_tgw_card_rank"
  | "invalid_modifiers"
  | "unsupported_difficulty";

type TraceCode =
  | "snapshot_hashed"
  | "mechanism_structure_identified"
  | "unverified_formula_not_executed"
  | "exact_integer_reconciliation_required"
  | "release_mismatch"
  | "rule_set_mismatch"
  | "unsupported_snapshot_schema";

export type RuntimeUiLabels = {
  locale: string;
  highScore: {
    currentEmpty: string;
    targetViewMode: string;
    enterCurrentRating: string;
    targetAchieved: string;
    scoreRateGap: string;
    noReward: string;
    copied: string;
    copyFailed: string;
  };
  teamDraft: {
    copied: string;
    copyFailed: string;
    unknownPrefix: string;
    selectMember: string;
    selectSupport: string;
    complete: string;
    incomplete: string;
    member: string;
    support: string;
    emptySkills: string;
    tgwBonus: string;
    tgwDefault: string;
    slot: string;
    editSlot: string;
    leader: string;
    memberSlot: string;
    supportSlot: string;
    validDraft: string;
    draftIssues: string;
    validDraftNote: string;
    issues: Record<TeamIssueCode, string>;
  };
  scoringResearch: {
    fixed: string;
    blankDraft: string;
    notSelected: string;
    power: string;
    invalidInput: string;
    chartUnavailable: string;
    song: {
      invalidShare: string; unavailable: string; breakdown: string;
      scenario: string; factors: string; topology: string; skill: string;
      gekisouUnavailable: string; gekisouPower: string; gekisouSection: string;
      gekisouEstimate: string; gekisouSectionScore: string;
      orderPercentiles: string; samplePercentiles: string;
      growthUnavailable: string; leader: string; slot: string;
      teamReady: string; teamIncomplete: string; chooseDifficulty: string;
      readingChart: string; workerFailed: string; resultTitle: string;
      resultAssumption: string; savedPerformanceAssumption: string; referenceGrowthAssumption: string; chooseChart: string; completeTeam: string;
      calculating: string; calculatingDetail: string; replayTitle: string;
      replayAssumption: string; replayScenario: string; rankingLink: string;
      replayBreakdown: string; replayOrder: string; replayState: string;
    };
    performance: {
      tooLarge: string; invalidJson: string; applied: string; reset: string;
      chooseChart: string; templateReady: string; notApplied: string; chartBound: string;
    };
    fields: {
      track: string;
      difficulty: string;
      cards: string;
      tgwCard: string;
      noteObjects: string;
      fullCombo: string;
    };
    trace: Record<TraceCode, string>;
    issues: Record<TeamIssueCode, string>;
  };
  scoreWorkbench: {
    seconds: string;
    atlas: {
      invalidRange: string; adjustedRange: string; segments: string; fullSong: string;
      selectedOverview: string; fullOverview: string; focusSegment: string;
      expand: string; fromHere: string; analyze: string; segment: string;
    };
    terms: {
      time: string;
      combo: string;
      lane: string;
      position: string;
      width: string;
      direction: string;
      timeSignature: string;
      fever: string;
    };
    direction: { left: string; right: string; none: string };
    fever: { inside: string; outside: string };
  };
  characterMedia: {
    records: string;
    metadataOnly: string;
    loading: string;
    ready: string;
    active: string;
    errorRetry: string;
    cancelled: string;
    notLoaded: string;
    showLoaded: string;
    loadAndShow: string;
    cancelLoading: string;
    playIdle: string;
    motion: string;
    motionDirection: string;
    playMotion: string;
    stopMotion: string;
    motionReady: string;
    motionLoading: string;
    motionPlaying: string;
    motionStopped: string;
    motionFinished: string;
    motionFailed: string;
    noWebModel: string;
    loadingDetailBefore: string;
    loadingDetailAfter: string;
    readyDetail: string;
    activeDetail: string;
    errorDetail: string;
    idleDetail: string;
    activating: string;
    dynamicLive2d: string;
    characterFallback: string;
    costume: string;
    staticAsset: string;
    finishedModelPreview: string;
    profilePoster: string;
    previewPending: string;
    defaultCostume: string;
    completeModel: string;
    available: string;
    pendingConversion: string;
    staticDisplay: string;
  };
  autoStage: {
    combo: string;
    playDemo: string;
    pauseDemo: string;
    readingChart: string;
    noPlayableAudio: string;
    chartLoadFailed: string;
    playbackDenied: string;
    states: {
      idle: string;
      loading: string;
      ready: string;
      playing: string;
      paused: string;
      seeking: string;
      ended: string;
      error: string;
    };
    skin: {
      realBackground: string;
      realLane: string;
      realNotes: string;
      formalArrows: string;
      staticEffects: string;
      cssStage: string;
    };
  };
};

const zhTeamIssues: Record<TeamIssueCode, string> = {
  invalid_modifiers: "加成设置格式无效，请重置成长与加成设置",
  invalid_draft: "TeamDraft 必须是对象",
  unsupported_schema: "草稿 schemaVersion 不受支持",
  unknown_rule_set: "草稿 ruleSetVersion 未知",
  invalid_slots: "草稿必须包含五个编成槽位",
  invalid_slot: "槽位结构无效",
  unknown_member_card: "成员卡不属于当前 Release",
  unknown_support_card: "留影不属于当前 Release",
  unknown_song: "歌曲不属于当前 Release",
  invalid_tgw_card_rank: "T.G.W CARD 等级不属于当前 Release",
  unsupported_difficulty: "难度不受当前工具支持"
};

const enTeamIssues: Record<TeamIssueCode, string> = {
  invalid_modifiers: "Invalid modifiers; reset growth and bonus settings",
  invalid_draft: "TeamDraft must be an object",
  unsupported_schema: "Draft schemaVersion is unsupported",
  unknown_rule_set: "Draft ruleSetVersion is unknown",
  invalid_slots: "Draft must contain five formation slots",
  invalid_slot: "Slot structure is invalid",
  unknown_member_card: "Member card is not in the current Release",
  unknown_support_card: "Snap is not in the current Release",
  unknown_song: "Track is not in the current Release",
  invalid_tgw_card_rank: "T.G.W CARD rank is not in the current Release",
  unsupported_difficulty: "Difficulty is unsupported by this tool"
};

const zhCN: RuntimeUiLabels = {
  locale: "zh-CN",
  highScore: {
    currentEmpty: "尚未填写",
    targetViewMode: "目标查看模式",
    enterCurrentRating: "填写当前 Rating 后计算",
    targetAchieved: "目标已达成",
    scoreRateGap: "High Score Rate 差额",
    noReward: "该阶段没有奖励记录",
    copied: "目标链接已复制",
    copyFailed: "复制失败，请从地址栏复制"
  },
  teamDraft: {
    copied: "已复制",
    copyFailed: "浏览器未授权剪贴板，请从下方 JSON 手动复制",
    unknownPrefix: "未识别：",
    selectMember: "选择成员卡",
    selectSupport: "选择留影",
    complete: "编队完整 · 5 张成员卡 + 5 张留影",
    incomplete: "编队未完成",
    member: "成员",
    support: "支援",
    emptySkills: "选择卡牌后显示技能摘要。",
    tgwBonus: "等级 {rank}：所有能力值提升 {percent}%（{bp} BP），以成员能力、评级和回忆为基数，逐槽位、逐维取整。",
    tgwDefault: "未填写时按等级 1 计算，T.G.W CARD 能力加成为 0。",
    slot: "槽位",
    editSlot: "编辑位置",
    leader: "队长",
    memberSlot: "成员卡",
    supportSlot: "留影",
    validDraft: "草稿结构有效",
    draftIssues: "个草稿问题",
    validDraftNote:
      "此结论只验证当前 Release 的 ID 和草稿结构，不代表正式游戏编成规则已通过。",
    issues: zhTeamIssues
  },
  scoringResearch: {
    fixed: "已固定",
    blankDraft: "空白草稿",
    notSelected: "未选择",
    power: "综合能力 · 代码复算",
    invalidInput: "输入无效",
    chartUnavailable: "谱面未加载，仅有目录摘要",
    song: {
      growthUnavailable: "个人养成未载入：",
      leader: "队长",
      slot: "位置",
      teamReady: "队伍已就绪。选歌后自动估算，切换歌曲无需重新选卡。",
      teamIncomplete: "已选 {selected} / 10 张卡。选择保存的队伍，或点击「编辑 / 创建队伍」补齐。",
      chooseDifficulty: "点击难度选定谱面",
      readingChart: "读取谱面…",
      workerFailed: "后台计算失败，请重新选择模式再试。",
      resultTitle: "当前歌曲期望分数",
      referenceGrowthAssumption: "这份队伍含参考或缺失的养成，分数不能当作当前实际可用成绩。",
      savedPerformanceAssumption: "使用保存的发挥条件；可在下方查看本次计算条件。",
      resultAssumption: "默认全 Perfect（AP）、满生命。不同技能顺序会带来分数变化，以下显示参考平均分和范围。",
      chooseChart: "请选择歌曲和难度。",
      completeTeam: "还没有完整队伍。先自动配队，或在编队页选满 5 张成员和 5 张留影。",
      calculating: "计算中…",
      calculatingDetail: "正在后台逐音符计算，你可以继续调整条件。",
      replayTitle: "本局判定回放分数",
      replayAssumption: "按输入的逐音符判定、输入帧和固定技能顺序回放一次；结果对应这组条件，不是实战预测。",
      replayScenario: "使用显式判定输入；生命、连击和技能条件随回放变化。",
      replayBreakdown: "相同判定下不含演出技能 {base}；本次技能增加 {gain}。",
      replayOrder: "按固定技能顺序回放一次，不表示随机顺序分布。",
      replayState: "最大连击 {combo} · 结束生命 {life} · 最低生命 {lowest} · Miss {miss} / Bad {bad} · 技能转换 {converted} 个判定",
      rankingLink: "查看歌曲排行榜 →",
      invalidShare: "分享链接包含无效输入，请返回编成页修正。",
      unavailable: "暂无法计算",
      gekisouUnavailable: "完整分数尚不可计算",
      gekisouPower: "综合力 {power}。激奏技能状态、抽选与区段结算顺序仍待闭合，不能套用普通演出分数。",
      gekisouSection: "第 {index} 段 {mission}：{start}–{end} 秒；第 1–5 名额外奖励分别为区段得分的 {percents}%。",
      gekisouEstimate: "逐帧条件模拟 · 综合力 {power} · {samples} 次；样本范围 {min}–{max}，均分抽样标准误 {error}（不含模型误差）。激奏奖励占比 {share}%。",
      gekisouSectionScore: "第 {index} 段 {mission}：音符分 {notes}＋名次奖励 {bonus}（平均名次 {rank}），占总分 {share}%；JUST 判定 {just} 次，激奏 COMBO {combo}，LUCK 点 {luck}。",
      breakdown: "不含演出技能 {base}；技能平均增加 {gain}。120 种随机顺序范围：{min}–{max}。",
      orderPercentiles: "技能顺序分位：P10 {p10}，P50 {p50}，P90 {p90}。假定 120 种顺序等可能；不代表实战保底。",
      samplePercentiles: "本次样本分位：P10 {p10}，P50 {p50}，P90 {p90}；有限样本不代表理论极值或真实随机分布。",
      scenario: "计算情景：普通非活动演出、全 Perfect、满生命、无辅助模式。",
      factors: "综合能力 {power}；难度倍率 {factor}；换算音符数 {notes}（按权重计算，不以 FC 计数代替）。",
      topology: "计分事件 {events}；正式 Master 连击数 {master}。",
      skill: "槽位 {slot}：成员技能 Lv.{member}，留影技能 Lv.{support}（0 = 无此技能），演出技能延长 {duration} ms。"
    },
    performance: {
      tooLarge: "判定 JSON 不能超过 8 MB。",
      invalidJson: "判定 JSON 格式不正确，请检查后重新应用。",
      applied: "已应用 {count} 个判定。技能顺序固定为 {order}。",
      reset: "已恢复全 Perfect、满生命参考。",
      chooseChart: "请先选择歌曲和难度。",
      templateReady: "模板已生成，也可直接编辑下方 JSON 后应用。",
      notApplied: "请先导入并应用当前谱面的判定 JSON。",
      chartBound: "判定输入与当前谱面绑定；下载模板或导入后应用。"
    },
    fields: {
      track: "歌曲",
      difficulty: "难度",
      cards: "卡牌",
      tgwCard: "T.G.W CARD",
      noteObjects: "谱面对象",
      fullCombo: "FC 计数"
    },
    trace: {
      snapshot_hashed: "输入已按稳定字段排序并生成哈希",
      mechanism_structure_identified: "已关联本地 Master 与 IL2CPP 机制证据",
      unverified_formula_not_executed:
        "谱面已按正式包重建；整曲仍按理想输入假设提供明确标注的估算结果。",
      exact_integer_reconciliation_required: "核验标准为正式包代码与独立整数复算；无需真实打一盘。",
      release_mismatch: "输入 Release 与证据 Release 不一致",
      rule_set_mismatch: "输入规则版本与当前规则版本不一致",
      unsupported_snapshot_schema: "输入快照版本不受支持"
    },
    issues: zhTeamIssues
  },
  scoreWorkbench: {
    seconds: "秒",
    atlas: {
      invalidRange: "请选择有效时段。", adjustedRange: "此难度时长较短，已调整到可用范围。",
      segments: "段", fullSong: "全曲", selectedOverview: "所选时段总览", fullOverview: "全曲总览",
      focusSegment: "放大第 {index} 段", expand: "展开", fromHere: "从这里开始", analyze: "定位分析", segment: "第 {index} 段"
    },
    terms: {
      time: "时间",
      combo: "当前 Combo",
      lane: "逻辑轨",
      position: "位置",
      width: "宽度",
      direction: "方向",
      timeSignature: "拍号",
      fever: "激奏区间"
    },
    direction: { left: "左", right: "右", none: "无" },
    fever: { inside: "区间内", outside: "区间外" }
  },
  characterMedia: {
    records: "条记录",
    metadataOnly: "仅元数据",
    loading: "正在加载",
    ready: "资源已就绪",
    active: "当前展示中",
    errorRetry: "加载失败 · 可重试",
    cancelled: "已取消",
    notLoaded: "尚未加载",
    showLoaded: "展示已加载模型",
    loadAndShow: "加载并展示",
    cancelLoading: "取消加载",
    playIdle: "播放 Idle 动作",
    motion: "动作",
    motionDirection: "朝向",
    playMotion: "播放动作",
    stopMotion: "停止动作",
    motionReady: "请选择动作；动作文件仅在播放时加载。",
    motionLoading: "正在加载动作",
    motionPlaying: "正在播放",
    motionStopped: "动作已停止；角色保持自然待机。",
    motionFinished: "动作已完成；角色保持自然待机。",
    motionFailed: "动作加载失败，动态立绘仍可继续使用。",
    noWebModel: "该服装源包缺少完整 Web 模型，当前使用成品静态预览。",
    loadingDetailBefore: "正在后台读取该服装的 Live2D 文件（",
    loadingDetailAfter: "）；切换服装或关闭弹层会取消当前读取。",
    readyDetail: "Live2D 文件已就绪，返回这套服装时会直接建立展示。",
    activeDetail: "动态 Live2D 已运行：当前启用自动眨眼、呼吸与指针视线。",
    errorDetail: "该服装加载失败，其他服装不受影响；可点击重试。",
    idleDetail: "该服装支持动态 Live2D；加载状态会在服装之间独立保留。",
    activating: "资源已就绪，正在建立浏览器 Live2D 展示…",
    dynamicLive2d: "动态 Live2D",
    characterFallback: "角色",
    costume: "服装",
    staticAsset: "静态素材",
    finishedModelPreview: "完整模型预览",
    profilePoster: "构建期角色海报（非服装渲染）",
    previewPending: "成品预览待补充",
    defaultCostume: "默认服装",
    completeModel: "完整模型成品",
    available: "可用",
    pendingConversion: "待转换",
    staticDisplay: "静态展示"
  },
  autoStage: {
    combo: "当前 Combo",
    playDemo: "播放演示",
    pauseDemo: "暂停演示",
    readingChart: "正在读取标准化谱面…",
    noPlayableAudio: "当前曲目无可播放音频",
    chartLoadFailed: "谱面数据加载失败，请刷新后重试。",
    playbackDenied: "浏览器未允许播放，请先使用上方音频控件播放一次。",
    states: {
      idle: "等待播放",
      loading: "正在加载音频",
      ready: "谱面就绪",
      playing: "Auto 演示中",
      paused: "已暂停",
      seeking: "正在定位",
      ended: "演示结束",
      error: "音频播放失败"
    },
    skin: {
      realBackground: "真实背景",
      realLane: "真实轨道",
      realNotes: "真实音符",
      formalArrows: "正式箭头 / 图标",
      staticEffects: "静态特效",
      cssStage: "CSS 舞台"
    }
  }
};

const en: RuntimeUiLabels = {
  locale: "en",
  highScore: {
    currentEmpty: "Not entered",
    targetViewMode: "Target view",
    enterCurrentRating: "Enter current Rating to calculate",
    targetAchieved: "Target achieved",
    scoreRateGap: "High Score Rate gap",
    noReward: "No reward is recorded for this tier",
    copied: "Target link copied",
    copyFailed: "Copy failed; copy the URL from the address bar"
  },
  teamDraft: {
    copied: "Copied",
    copyFailed: "Clipboard access was denied; copy the JSON below",
    unknownPrefix: "Unknown: ",
    selectMember: "Select member card",
    selectSupport: "Select snap",
    complete: "Team complete · 5 member cards + 5 snaps",
    incomplete: "Team incomplete",
    member: "Members",
    support: "Snaps",
    emptySkills: "Select cards to show skill summaries.",
    tgwBonus: "Rank {rank}: all power +{percent}% ({bp} BP), applied to member power, ranks and memories, floored per slot and component.",
    tgwDefault: "Defaults to rank 1 with zero T.G.W power bonus.",
    slot: "Slot",
    editSlot: "Edit slot",
    leader: "Leader",
    memberSlot: "Member card",
    supportSlot: "Snap",
    validDraft: "Draft structure is valid",
    draftIssues: "draft issues",
    validDraftNote:
      "This validates IDs and draft structure for the current Release; it does not verify official formation rules.",
    issues: enTeamIssues
  },
  scoringResearch: {
    fixed: "Fixed",
    blankDraft: "Blank draft",
    notSelected: "Not selected",
    power: "Formation power from code",
    invalidInput: "Invalid input",
    chartUnavailable: "Chart not loaded; catalog summary only",
    song: {
      growthUnavailable: "Personal growth could not be loaded: ",
      leader: "Leader",
      slot: "Slot",
      teamReady: "Team ready. Choose a song to calculate; switching songs keeps your cards.",
      teamIncomplete: "{selected} / 10 cards selected. Choose a saved team or use Edit / Create team to complete it.",
      chooseDifficulty: "Choose a difficulty to select a chart",
      readingChart: "Loading chart…",
      workerFailed: "Background calculation failed. Select a mode again to retry.",
      resultTitle: "Expected song score",
      referenceGrowthAssumption: "This team contains reference or missing growth records; its score does not describe a confirmed current team.",
      savedPerformanceAssumption: "Using the saved performance scenario; see calculation conditions below.",
      resultAssumption: "Assumes all Perfect (AP) and full life. Skill order changes the score; the mean and range below are estimates.",
      chooseChart: "Choose a song and difficulty.",
      completeTeam: "Your team is incomplete. Use team recommendations or select 5 members and 5 snaps in Team Builder.",
      calculating: "Calculating…",
      calculatingDetail: "Calculating each note in the background. You can keep adjusting the settings.",
      replayTitle: "Judgement replay score",
      replayAssumption: "Replays the supplied note judgements, input frames and fixed skill order once. This result describes those inputs, not a prediction of actual play.",
      replayScenario: "Uses explicit judgements; life, combo and skill conditions change throughout the replay.",
      replayBreakdown: "Same judgements without live skills: {base}; skill gain in this replay: {gain}.",
      replayOrder: "Replayed once with a fixed skill order; this is not a random-order distribution.",
      replayState: "Max combo {combo} · Final life {life} · Lowest life {lowest} · Miss {miss} / Bad {bad} · {converted} converted judgements",
      rankingLink: "View song rankings →",
      invalidShare: "The shared link has invalid input. Return to the deck builder to correct it.",
      unavailable: "Cannot calculate yet",
      gekisouUnavailable: "Full score not available",
      gekisouPower: "Power {power}. Gekisou skill state, lottery and section settlement order remain incomplete; ordinary scores do not apply.",
      gekisouSection: "Section {index}, {mission}: {start}–{end} s. Additional rewards for ranks 1–5: {percents}% of section score.",
      gekisouEstimate: "Conditional frame replay · power {power} · {samples} samples; observed range {min}–{max}, sampling standard error {error} (excluding model error). Ranking bonus share {share}%.",
      gekisouSectionScore: "Section {index}, {mission}: notes {notes} + ranking bonus {bonus} (mean rank {rank}), {share}% of total; JUST judgements {just}, Gekisou combo {combo}, LUCK points {luck}.",
      breakdown: "Without live skills: {base}; average skill gain: {gain}. Range across 120 random orders: {min}–{max}.",
      orderPercentiles: "Skill-order percentiles: P10 {p10}, P50 {p50}, P90 {p90}. Assumes 120 equally likely orders; not a real-play guarantee.",
      samplePercentiles: "Observed sample percentiles: P10 {p10}, P50 {p50}, P90 {p90}. Finite samples do not establish theoretical bounds or the true random distribution.",
      scenario: "Scenario: ordinary non-event live, all Perfect, full life, no assist mode.",
      factors: "Power {power}; difficulty factor {factor}; converted notes {notes} (weighted, not the FC count).",
      topology: "Scoring events {events}; production Master combo count {master}.",
      skill: "Slot {slot}: member skill Lv.{member}, support skills Lv.{support} (0 = absent), live skill extended by {duration} ms."
    },
    performance: {
      tooLarge: "Judgement JSON must not exceed 8 MB.",
      invalidJson: "Judgement JSON is invalid. Check it and apply again.",
      applied: "Applied {count} judgements. Fixed skill order: {order}.",
      reset: "Restored the all-Perfect, full-life reference.",
      chooseChart: "Choose a song and difficulty first.",
      templateReady: "Template created. You can also edit the JSON below and apply it.",
      notApplied: "Import and apply judgement JSON for the current chart first.",
      chartBound: "Judgements are bound to this chart. Download a template, or import and apply your JSON."
    },
    fields: {
      track: "Track",
      difficulty: "Difficulty",
      cards: "Cards",
      tgwCard: "T.G.W CARD",
      noteObjects: "Note objects",
      fullCombo: "FC count"
    },
    trace: {
      snapshot_hashed: "Input was sorted by stable fields and hashed",
      mechanism_structure_identified:
        "Local Master and IL2CPP mechanism evidence is linked",
      unverified_formula_not_executed:
        "Chart events are reconstructed from production code; whole-song estimates explicitly assume ideal input.",
      exact_integer_reconciliation_required:
        "Verification uses production code and independent integer calculation; no played match is required.",
      release_mismatch: "Input Release does not match the evidence Release",
      rule_set_mismatch:
        "Input rule version does not match the current rule version",
      unsupported_snapshot_schema: "Input snapshot version is unsupported"
    },
    issues: enTeamIssues
  },
  scoreWorkbench: {
    seconds: "sec",
    atlas: {
      invalidRange: "Choose a valid time range.", adjustedRange: "This difficulty is shorter; the range was adjusted to fit.",
      segments: "segments", fullSong: "Full song", selectedOverview: "Selected range overview", fullOverview: "Full song overview",
      focusSegment: "Expand segment {index}", expand: "Expand", fromHere: "Start here", analyze: "Analyze here", segment: "Segment {index}"
    },
    terms: {
      time: "Time",
      combo: "Current Combo",
      lane: "Logical lane",
      position: "Position",
      width: "Width",
      direction: "Direction",
      timeSignature: "Time signature",
      fever: "Gekisou section"
    },
    direction: { left: "Left", right: "Right", none: "None" },
    fever: { inside: "Inside range", outside: "Outside range" }
  },
  characterMedia: {
    records: "records",
    metadataOnly: "Metadata only",
    loading: "Loading",
    ready: "Resources ready",
    active: "Currently displayed",
    errorRetry: "Load failed · retry available",
    cancelled: "Cancelled",
    notLoaded: "Not loaded",
    showLoaded: "Show loaded model",
    loadAndShow: "Load and show",
    cancelLoading: "Cancel loading",
    playIdle: "Play Idle motion",
    motion: "Motion",
    motionDirection: "Direction",
    playMotion: "Play motion",
    stopMotion: "Stop motion",
    motionReady: "Choose a motion; its file loads only when played.",
    motionLoading: "Loading motion",
    motionPlaying: "Playing",
    motionStopped: "Motion stopped; the character remains naturally idle.",
    motionFinished: "Motion finished; the character remains naturally idle.",
    motionFailed: "Motion loading failed; the dynamic portrait remains available.",
    noWebModel:
      "This costume package has no complete Web model; the finished static preview is shown.",
    loadingDetailBefore: "Reading this costume's Live2D files in the background (",
    loadingDetailAfter:
      "); switching costumes or closing the dialog cancels the current read.",
    readyDetail:
      "Live2D files are ready; returning to this costume will create the display immediately.",
    activeDetail:
      "Dynamic Live2D is running with automatic blinking, breathing, and pointer gaze.",
    errorDetail:
      "This costume failed to load; other costumes are unaffected and this one can be retried.",
    idleDetail:
      "This costume supports dynamic Live2D and keeps independent load state.",
    activating: "Resources ready; creating the browser Live2D display…",
    dynamicLive2d: "Dynamic Live2D",
    characterFallback: "Character",
    costume: "Costume",
    staticAsset: "Static asset",
    finishedModelPreview: "Complete model preview",
    profilePoster: "Build-time character poster (not a costume render)",
    previewPending: "Finished preview pending",
    defaultCostume: "Default costume",
    completeModel: "Complete model",
    available: "Available",
    pendingConversion: "Pending conversion",
    staticDisplay: "Static display"
  },
  autoStage: {
    combo: "Current Combo",
    playDemo: "Play demo",
    pauseDemo: "Pause demo",
    readingChart: "Loading normalized chart…",
    noPlayableAudio: "No playable audio is available for this track",
    chartLoadFailed:
      "Chart data failed to load. Refresh the page and try again.",
    playbackDenied:
      "Playback was blocked. Start the audio once with the player above.",
    states: {
      idle: "Waiting to play",
      loading: "Loading audio",
      ready: "Chart ready",
      playing: "Auto demo playing",
      paused: "Paused",
      seeking: "Seeking",
      ended: "Demo ended",
      error: "Audio playback failed"
    },
    skin: {
      realBackground: "Authentic background",
      realLane: "Authentic lane",
      realNotes: "Authentic notes",
      formalArrows: "Official arrows / icons",
      staticEffects: "Static effects",
      cssStage: "CSS stage"
    }
  }
};

export const runtimeUiLabels = { "zh-CN": zhCN, en } as const;

export const getRuntimeUiLabels = (locale: string | undefined) =>
  locale === "en" ? runtimeUiLabels.en : runtimeUiLabels["zh-CN"];
