import { catalog } from "./catalog";
import scoringEvidenceData from "./scoring-evidence-default.json";
import formalRules from "../data/formal-scoring-rules.json";
import { scoringRulesAvailable } from "./scoring-release-gate.mjs";

const rulesAvailable = scoringRulesAvailable(formalRules, catalog.release.id);

export const scoringEvidence = scoringEvidenceData;

export const scoringCapability = {
  sourceReleaseId: catalog.release.id,
  status: rulesAvailable ? "estimated" as const : "unverified" as const,
  calculatorEnabled: rulesAvailable,
  optimizerEnabled: rulesAvailable,
  exactSongScoreEnabled: false,
  formationPowerEnabled: rulesAvailable,
  pairingOptimizerEnabled: rulesAvailable,
  evidence: {
    cardCount: catalog.memberCards.length + catalog.supportCards.length,
    trackCount: catalog.musicTracks.length,
    chartCount: catalog.musicCharts.length,
    comboBonusRowCount: scoringEvidence.masterEvidence.comboBonus.rowCount,
    scoreRankRowCount: scoringEvidence.masterEvidence.scoreRank.rowCount,
    skillEffectRowCount: scoringEvidence.masterEvidence.skillEffect.rowCount,
    nativeMethodCount: (scoringEvidence.nativeEvidence as Array<{ methodCount: number }>).reduce(
      (total, entry) => total + entry.methodCount,
      0
    )
  },
  blockers: [
    "同刻音符判定顺序与技能触发采用理想输入假设，尚未完整模拟帧内执行顺序",
    "谱面重建连击数与 Master 对照；总数吻合不等于完整逐帧核验",
    "参考发挥样本不能代替个人实战记录；整曲结果仍需按具体输入条件理解"
  ],
  goConditions: [
    "从参考正式包还原常量与调用规则；难度增量已独立解码为 0.005",
    "固定输入下用独立代码复算整数结果及中间值",
    "代码核验不要求真实对局回放；整曲估算不冒充客户端实测"
  ],
  knownMechanisms: [
    "基础音符分与核心音符分入口",
    "倍率、固定分、判定与 Combo 加成命令",
    "激奏 Combo 修正与玩家贡献拆分",
    "五个槽位、第三槽队长；留影属性为 BP 比率",
    "成员成长、评级、回忆、队长、留影、连携、TGW、乐器及歌曲属性逐项取整",
    "CalcNoteScoreCore 已确认以 100 为百分比除数，并包含两次向下取整",
    "技能值除 10000；留影延长值为毫秒；留影技能等级随突破变化",
    "逐音符权重换算分母、Combo 累计及 120 种随机技能顺序"
  ],
  staticAuditStatus: (scoringEvidence.staticAnalysis as Array<{ status: string }>)[0]?.status ?? "missing",
  ruleSetVersion: formalRules.ruleSetVersion,
  replaySampleCount: scoringEvidence.validationGate.replaySampleCount,
  fixtureReplayCount: scoringEvidence.validationGate.fixtureReplayCount,
  observedReplayCount: scoringEvidence.validationGate.observedReplayCount,
  formalCapability: scoringEvidence.validationGate.formalCapability,
  gate: scoringEvidence.validationGate.gate
};
