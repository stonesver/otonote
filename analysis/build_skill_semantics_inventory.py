"""Build an offline, versioned semantic inventory; never writes runtime data.

Full Master outputs belong outside the repository. 'complete' means the listed
fields have a design interpretation, not that a whole skill passed a client run.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = {
    'LeaderSkill': ('队长', 'MemberCard', ['_leaderSkillID']),
    'LiveSkill': ('普通成员', 'MemberCard', ['_liveSkillID']),
    'SupportSkill': ('普通留影', 'SupportCard', ['_supportSkillId01', '_supportSkillId02']),
    'GekisouSkill': ('激奏成员', 'MemberCard', ['_gekisouSkillID']),
    'GekisouSupportSkill': ('激奏留影', 'SupportCard', ['_gekisouSupportSkillId01', '_gekisouSupportSkillId02']),
}
ROLES = dict(trigger='_skillTriggerConditionGroup', eligibility='_skillConditionGroup',
             release='_skillReleaseConditionGroup', budgetReset='_effectExecuteLimitResetConditionGroup')
OPS = {
    1000: ('power.all', '全部能力加成', 'basis_point'),
    1001: ('power.technic', '技巧加成', 'basis_point'),
    1002: ('power.visual', '形象加成', 'basis_point'),
    1003: ('power.performance', '表演加成', 'basis_point'),
    1500: ('power.all.per_member', '按人数增加全部能力', 'basis_point_per_member'),
    1501: ('power.technic.per_member', '按人数增加技巧', 'basis_point_per_member'),
    1502: ('power.visual.per_member', '按人数增加形象', 'basis_point_per_member'),
    1503: ('power.performance.per_member', '按人数增加表演', 'basis_point_per_member'),
    2000: ('score.rate', '得分加成', 'basis_point'),
    2001: ('score.cumulative_rate', '累计得分加成', 'basis_point_per_step'),
    2004: ('score.target_judgement_rate', '指定判定得分加成', 'basis_point'),
    3001: ('life.recover', '恢复 LIFE', 'life_point'),
    3004: ('life.damage_reduction', '生命伤害减轻', 'basis_point'),
    4004: ('judgement.window_expand', 'JUST 判定窗口扩张', 'basis_point'),
    11001: ('luck.note_gauge_gain', '音符提供抽选槽量增加', 'basis_point'),
    11002: ('luck.points', '追加 LUCK 点数', 'point'),
    11003: ('luck.gauge_add', '立即增加抽选槽', 'basis_point'),
    11005: ('luck.result_floor', '抽奖结果保底', 'result_code_one_based'),
    12000: ('combo.count_gain', 'COMBO 任务额外计数', 'count'),
    12004: ('combo.guard', '任务 COMBO 保护', 'unused_raw_value'),
    12006: ('judgement.convert', '判定转换', 'judgement_code'),
    13000: ('just.count_gain', 'JUST 任务额外计数', 'count'),
    13002: ('just.cumulative_gain', '累计 JUST 额外计数', 'count_per_step'),
    13005: ('judgement.charged_just', '充能 JUST 转换', 'unused_raw_value'),
    15000: ('paired_member.duration_extend', '所配成员技能延长', 'millisecond'),
}
PREDICATES = {
    1020: 'effective_judgement_matches', 1030: 'effective_judgement_interval',
    2001: 'life_at_least', 3000: 'formation_has_matching_member',
    4010: 'paired_member_skill_activation', 4011: 'random_chance_percent',
    5000: 'paired_member_band_matches', 7000: 'lottery_result_equals',
    7005: 'current_task_combo_at_least', 7010: 'section_entry',
    7013: 'section_end', 7020: 'section_active', 7021: 'luck_rush_active',
}
REASONS = {
    'leader_cumulative_required': '本来源版本尚无累计条件 ID=0 的默认求值依据；保留原码，不从其他版本自动继承倍率 1',
    'leader_zero_cumulative_runtime_mismatch': 'global build 86 的累计条件 ID=0 返回恒等倍率 1；当前网站执行器却拒绝。需补该分支及搜索上界，不能修改原始 1503 或伪造人数计数器',
    'combo_threshold_lifetime_runtime_mismatch': '修复持续条件失效撤销、清理重入及双档切换；接入原生命令回归',
    'compound_trigger_timestamp_runtime_mismatch': '按根 AND 检查器取当前更新时间，不继承子 COMBO 判定时间',
    'missing_effects': '只有父定义／卡片引用，没有效果行，不能补成无效果',
    'new_combination_review': '组合未出现在基线快照；登记现有实现／测试证据或补组合回归后再开放自动接入，不等于必然缺实现',
    'ordinary_trigger_adapter': '普通执行器需支持该触发程序；现有路径只接受成员发动或受限开局条件',
    'ordinary_operator_adapter': '普通执行器的效果白名单缺此操作，需补生命周期与数值／消耗实现',
    'leader_condition_adapter': '队长条件执行器目前只接受单组单条件 3000；需补此组合',
    'leader_target_adapter': '补队长目标筛选及相应队伍能力计算',
    'ordinary_condition_adapter': '补普通技能资格条件编译',
    'new_lifecycle_combination': '持续触发与时长／解除／预算的新组合需要单独确认',
    'summary_templates': '接入等级参数、条件／目标、预算及折叠摘要模板',
    'tag_rules': '接入网站自有标签映射、来源字段和版本；未知机制不推导标签',
    'score_semantic_adapter': '把语义记录接到计分入口，按请求判定上下文、证据与已知分歧',
    'team_semantic_adapter': '配队复用计分支持状态，声明候选排除范围并更新缓存／搜索上界',
}
CONTRACTS = {
    'leader': '受益成员逐个筛选；目标对象间 OR、对象内非零约束 AND；实际技能分类数组用交集。人数累计另设选择器，每成员只计一次并按上限截断；global build 86 的累计型操作在累计条件 ID=0 时用恒等倍率 1，不创建人数计数器。同一受益成员同分量相加，all 展开三分量。',
    'ordinary': '成员发动／支援事件、资格与解除分开；同帧输入先处理，恢复在 LIFE 条件加分前；时长含所配留影延长，float32 后依执行器时间规则结束。判定解除不在激活帧及紧接 ExecuteFrame 检查。',
    'gekisou': '输入和普通演出更新后执行技能阶段，任务更新在后；条件读取技能阶段 LIFE 与此前已完成任务更新的任务计数。原生完整混合调度未整场验证。',
    'counter': '间隔计数、累计奖励、任务 COMBO、基础有效 JUST、HitCount 与时间戳分别保存。1030 按效果实例／区段／条件 ID 计数；等待中累计触发计数，成功匹配后取模消费。',
    'budget': '激奏发动预算归演出／槽位／技能域／效果行；一次发动的额度另存，只有显式重置条件清发动预算。充能转换仅成功转换消耗一个来源，原本 JUST 不消耗；COMBO 保护消耗所有匹配来源；保底按抽奖结算规则消费。普通支援按所配来源单独拥有状态。',
    'random': '确定性门槛先于随机；OR 按来源顺序选择首个成功分支；概率与抽奖结果事件独立。种子、技能顺序、区段进入抽样兼容规则须作为计算上下文。',
    'evidence': 'complete 仅表示设计字段能表达。当前实现、局部原生证据、整场客户端验收是独立维度；较新同数据行不自动取得同版原生证据。',
}
EFFECT_FIELDS = {'_id', '_level', '_skillEffectType', '_effectValue', '_maxEffectValue',
                 '_activationTimeSecond', '_effectLimitCount', '_effectExecuteLimitCount',
                 '_skillCumulativeConditionID', '_skillTargetIDs', '_skillTriggerType', '_icon', *ROLES.values()}
TARGET_FIELDS = {'_id', '_skillTargetType', '_characterID', '_bandID', '_cardType', '_tagID',
                 '_judgement', '_liveMusicType', '_gekisouMissionType', '_liveSkillCategories', '_gekisouSkillCategories'}
# Bind the documented build-25 evidence to its audited data closure, never an
# ID alone. Changed parameters can reuse a design without inheriting a direct
# native result. Revisit these bindings when the model/source evidence changes.
NATIVE_CLOSURES = {
    12: '048119b8edec4cde13810b0fa05ef4553f8fbe8830f56b3dfd3c19ac06c59cf4',
    13: '460e416b4137133f68e9c45bcf7c25c36cc87418e2cff00437617b3500f4d5e6',
    18: '0874a0fae228ccbca27891a2e9227bf3dbf5c6959a4b057803f530fa6b8dda29',
    19: '7b67033b2b90c1daaec30904d24c2366186f56d0bb6413aa21d1d93d28608935',
}


def describe(reason):
    return REASONS.get(reason, '需确认并补映射：' + reason)


def source_key(family):
    return '_' + family[0].lower() + family[1:] + 'ID'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Inventory:
    def __init__(self, tables, version):
        self.t, self.version = tables, version
        self.by = {name: {r['_id']: r for r in rows} for name, rows in tables.items()}
        self.sets = defaultdict(list)
        for row in tables['SkillConditionSet']:
            self.sets[row['_group']].append(row)

    def targets(self, ids, issues):
        result = []
        for id_ in ids:
            r = self.by['SkillTarget'].get(id_)
            if r is None:
                issues.add(f'missing_target:{id_}'); result.append({'sourceId': id_, 'unresolved': True}); continue
            for k in r.keys() - TARGET_FIELDS:
                issues.add('unmapped_target_field:' + k)
            kind = {3: 'member', 4: 'effective_judgement', 5: 'mission_section'}.get(r['_skillTargetType'])
            if not kind:
                issues.add(f'unknown_target_type:{r["_skillTargetType"]}')
            if r['_liveMusicType']:
                issues.add('target_live_music_type_semantics')
            if r['_gekisouSkillCategories']:
                issues.add('target_gekisou_categories_semantics')
            # -1 is the unused judgement sentinel on member/section targets,
            # not an extra predicate on those different target domains.
            result.append({'sourceId': id_, 'kind': kind or 'unresolved', 'allOf': {
                k[1:]: v for k, v in r.items() if k not in ['_id', '_skillTargetType'] and v
                and not (k == '_judgement' and r['_skillTargetType'] != 4 and v == -1)}, 'raw': r})
        return {'operator': 'anyOf', 'selectors': result}

    def condition(self, group, issues):
        if not group:
            return {'sourceGroup': 0, 'anyOf': []}
        if group not in self.sets:
            issues.add(f'missing_condition_group:{group}')
        groups = []
        for s in self.sets[group]:
            predicates = []
            for id_ in s['_conditionIds']:
                c = self.by['SkillCondition'].get(id_)
                if c is None:
                    issues.add(f'missing_condition:{id_}'); predicates.append({'sourceId': id_, 'unresolved': True}); continue
                typ, vals, ids = c['_conditionType'], c['_conditionValues'], c['_conditionTargetIDs']
                pred = PREDICATES.get(typ)
                if not pred:
                    issues.add(f'unknown_condition:{typ}')
                if pred and ((typ in [1030, 2001, 4011, 7000, 7005] and len(vals) != 1)
                             or (typ not in [1030, 2001, 4011, 7000, 7005] and vals)):
                    issues.add(f'condition_parameter_semantics:{typ}')
                expected_targets = {1020: 4, 1030: 4, 3000: 3, 5000: 3, 7010: 5, 7020: 5}
                selectors = self.targets(ids, issues)
                if pred and ids and (typ not in expected_targets or any(
                        x.get('raw', {}).get('_skillTargetType') != expected_targets[typ] for x in selectors['selectors'])):
                    issues.add(f'condition_target_combination:{typ}')
                for field in c.keys() - {'_id', '_conditionType', '_conditionValues', '_isPositive', '_conditionTargetIDs'}:
                    issues.add('unmapped_condition_field:' + field)
                predicates.append({'sourceId': id_, 'predicate': pred or 'unresolved', 'code': typ,
                                   'positive': c['_isPositive'], 'parameters': vals, 'targets': selectors, 'raw': c})
            groups.append({'sourceSetId': s['_id'], 'allOf': predicates})
        return {'sourceGroup': group, 'anyOf': groups}

    def cumulative(self, id_, family, row, issues):
        if not id_:
            return None
        c = self.by['SkillCumulativeCondition'].get(id_)
        if c is None:
            issues.add(f'missing_cumulative:{id_}'); return {'sourceId': id_, 'unresolved': True}
        typ = c['_skillCumulativeConditionType']
        source = {1000: 'effective_judgements', 3000: 'matching_formation_members', 7001: 'current_task_combo'}.get(typ)
        if not source:
            issues.add(f'unknown_cumulative:{typ}')
        if typ == 3000 and c['_conditionValues'] != [1]:
            issues.add('leader_cumulative_parameters')
        if family == 'GekisouSkill' and row['_skillEffectType'] == 13002:
            source = 'base_effective_judgements_in_section_without_skill_bonus'
        for field in c.keys() - {'_id', '_skillCumulativeConditionType', '_conditionValues', '_conditionTargetIDs', '_maxCumulativeCount'}:
            issues.add('unmapped_cumulative_field:' + field)
        return {'sourceId': id_, 'code': typ, 'source': source or 'unresolved',
                'unitParameters': c['_conditionValues'], 'countCap': c['_maxCumulativeCount'],
                'targets': self.targets(c['_conditionTargetIDs'], issues),
                'formula': 'min(effectCap if nonzero, min(countCap, floor(sourceCount/unit))*step)', 'raw': c}

    def effect(self, family, row):
        issues, adapters = set(), set()
        op = row['_skillEffectType']; info = OPS.get(op)
        if not info:
            issues.add(f'unknown_operator:{op}')
        for field in row.keys() - EFFECT_FIELDS - {source_key(family)}:
            issues.add('unmapped_effect_field:' + field)
        programs = {role: self.condition(row.get(field, 0), issues) for role, field in ROLES.items()}
        target = self.targets(row['_skillTargetIDs'], issues)
        target['emptyMeans'] = 'all_formation_members' if family == 'LeaderSkill' else 'operator_defined_channel'
        cumulative = self.cumulative(row.get('_skillCumulativeConditionID', 0), family, row, issues)
        cumulative_evaluation = None
        if family == 'LeaderSkill' and op in [1500, 1501, 1502, 1503] and not cumulative:
            if self.version == 'global-1.1.0-86' and row.get('_skillCumulativeConditionID') == 0:
                cumulative_evaluation = {'mode': 'identity_without_condition', 'multiplier': 1,
                    'counter': None, 'sourceClient': 'global-1.1.0-86',
                    'evidence': 'leader-cumulative-default-native.json'}
                info = OPS[op - 500]  # semantic result only; original opcode remains intact
                adapters.add('leader_zero_cumulative_runtime_mismatch')
            else:
                issues.add('leader_cumulative_required')
        conditions = [p for program in programs.values() for g in program['anyOf'] for p in g['allOf']]
        trigger = [p for g in programs['trigger']['anyOf'] for p in g['allOf']]
        trigger_types = {p.get('code') for p in trigger}
        typ, duration = row.get('_skillTriggerType'), row.get('_activationTimeSecond', 0)
        timestamp = 'current_skill_update'
        if family == 'LeaderSkill':
            lifetime = 'formation_static'
            gs = programs['eligibility']['anyOf']
            if gs and not (len(gs) == 1 and len(gs[0]['allOf']) == 1 and gs[0]['allOf'][0].get('code') == 3000):
                adapters.add('leader_condition_adapter')
            if any(s.get('raw', {}).get('_gekisouSkillCategories') for s in target['selectors']):
                adapters.add('leader_target_adapter')
        elif family in ['LiveSkill', 'SupportSkill']:
            lifetime = 'instant' if op == 3001 else 'duration_modifier' if op == 15000 else 'timed'
            if family == 'SupportSkill':
                if op not in [15000, 12006, 3001, 2001]:
                    adapters.add('ordinary_operator_adapter')
                startup = op == 12006 and row['_effectExecuteLimitCount'] == 1 and trigger_types == {5000} and row['_skillTriggerConditionGroup'] == row['_skillConditionGroup']
                if trigger_types != {4010} and not startup:
                    adapters.add('ordinary_trigger_adapter')
                if startup:
                    lifetime = 'startup_limited_conversion'
                gs = programs['eligibility']['anyOf']
                if gs and not (len(gs) == 1 and len(gs[0]['allOf']) == 1 and gs[0]['allOf'][0].get('code') in [2001, 5000]):
                    adapters.add('ordinary_condition_adapter')
        else:
            lifetime = 'instant' if op in [11002, 11003] else 'timed' if duration else 'until_section_end_or_release'
            if typ not in [1, 2]:
                issues.add(f'unknown_trigger_type:{typ}')
            if typ == 2:
                lifetime = 'while_trigger_holds'
                release_types = {p.get('code') for g in programs['release']['anyOf'] for p in g['allOf']}
                # Explicit section-end release is already part of the existing
                # section-active contract, including finite COMBO protection.
                if duration or release_types - {7013} or row['_effectExecuteLimitCount']:
                    issues.add('new_lifecycle_combination')
            if 7010 in trigger_types or 7020 in trigger_types:
                timestamp = 'section_entry_or_current_update'
            if 7005 in trigger_types:
                pure = len(programs['trigger']['anyOf']) == 1 and len(trigger) == 1
                timestamp = 'last_combo_judgement' if pure else 'current_skill_update_root_AND'
                if len(programs['trigger']['anyOf']) > 1:
                    issues.add('combo_OR_lifecycle_and_root_time')
                adapters.add('combo_threshold_lifetime_runtime_mismatch')
                if not pure:
                    adapters.add('compound_trigger_timestamp_runtime_mismatch')
        setting = next((s for s in self.t['SkillEffectSetting'] if s['_skillEffectType'] == op), None)
        if not setting:
            issues.add(f'missing_effect_phase:{op}')
        parent = self.by.get(family, {}).get(row[source_key(family)], {})
        raw_closure = {'effect': row, 'conditions': programs, 'targets': target, 'cumulative': cumulative,
                       'phase': setting['_phase'] if setting else None,
                       'missionType': parent.get('_gekisouMissionType'),
                       'parentExecutionTiming': parent.get('_gekisouSupportSkillExecTiming')}
        return {'id': row['_id'], 'level': row['_level'], 'operation': {'code': op, 'name': info[0] if info else 'unresolved',
                'label': info[1] if info else f'待确认效果 {op}', 'value': row['_effectValue'],
                'unit': info[2] if info else 'unresolved', 'maximumValue': row.get('_maxEffectValue', 0)},
                'targets': target, 'conditions': programs, 'cumulative': cumulative,
                'cumulativeEvaluation': cumulative_evaluation,
                'lifetime': {'mode': lifetime, 'triggerType': typ, 'durationSeconds': duration,
                             'maintainProgram': 'trigger' if typ == 2 else None,
                             'eligibilityRead': 'activation' if typ != 2 else 'see_mechanism_contract',
                             'endAtSectionBoundary': family.startswith('Gekisou')},
                'timing': {'phase': setting['_phase'] if setting else None, 'installTime': timestamp,
                           'firstBenefitEvent': 'formation_power_aggregation' if family == 'LeaderSkill'
                           else 'activation' if op in [3001, 11002, 11003]
                           else 'eligible_judgement_conversion' if op in [12006, 13005]
                           else 'task_judgement_replay_from_command_time' if op in [12000, 13000, 13002, 12004]
                           else 'lottery_settlement' if op == 11005
                           else 'paired_member_skill_duration' if op == 15000
                           else 'next_damage' if op == 3004
                           else 'note_evaluation_while_active',
                           'conditionReadAt': 'skill_phase' if family.startswith('Gekisou') else 'formation' if family == 'LeaderSkill' else 'ordinary_skill_phase'},
                'budgets': {'activationLimit': row.get('_effectExecuteLimitCount', 0),
                            'perActivationEffectLimit': row.get('_effectLimitCount', 0),
                            'zeroMeans': 'unlimited_for_budgets_only', 'resetProgram': 'budgetReset',
                            'owner': 'performance/source_slot/domain/effect_row', 'consumptionContract': 'budget'},
                'intervalCounters': [{'conditionId': c['sourceId'], 'unit': c['parameters'][0],
                    'targets': c['targets'], 'scope': 'effect_instance/section/condition_id'} for c in conditions if c.get('code') == 1030],
                'contractRefs': ['leader' if family == 'LeaderSkill' else 'gekisou' if family.startswith('Gekisou') else 'ordinary', 'counter', 'budget', 'random', 'evidence'],
                'expressionStatus': 'partial' if issues else 'complete', 'unresolved': sorted(issues),
                'runtimeAdaptations': sorted(adapters), 'sourceClosureHash': digest(raw_closure), 'raw': row}

    def build(self):
        records = []
        for family, (label, card_table, fields) in FAMILIES.items():
            grouped = defaultdict(list)
            for r in self.t[family + 'Effect']:
                grouped[r[source_key(family)]].append(r)
            ids = set(grouped) | set(self.by.get(family, {}))
            ids.update(c[field] for c in self.t[card_table] for field in fields if c[field])
            for id_ in sorted(ids):
                refs = []
                for card in self.t[card_table]:
                    for slot, field in enumerate(fields, 1):
                        if not card[field] or card[field] != id_:
                            continue
                        levels = list(range(1, 6)) if card_table == 'MemberCard' else sorted({
                            r[f'_gekisouSupportSkill0{slot}Level' if family.startswith('Gekisou') else f'_supportSkill0{slot}Level']
                            for r in self.t['SupportCardRank'] if r['_group'] == card['_supportCardRankGroup']})
                        refs.append({'cardTable': card_table, 'cardId': card['_id'], 'slot': field,
                                     'reachableLevels': [n for n in levels if n],
                                     'textId': card.get('_subtitleTextID', card.get('_descriptionTextID'))})
                effects = [self.effect(family, r) for r in grouped[id_]]
                unresolved = sorted({s for e in effects for s in e['unresolved']} | (set() if effects else {'missing_effects'}))
                parent = self.by.get(family, {}).get(id_)
                if family in ['LiveSkill', 'GekisouSkill', 'GekisouSupportSkill'] and parent is None:
                    unresolved.append('missing_parent_definition')
                records.append({'key': f'{family}:{id_}', 'family': family, 'familyLabel': label, 'skillId': id_,
                    'parent': parent, 'references': refs, 'effects': effects,
                    'applicability': {'missionType': parent.get('_gekisouMissionType') if parent else None,
                                      'owner': 'leader' if family == 'LeaderSkill' else 'member' if card_table == 'MemberCard' else 'paired_support'},
                    'levels': sorted({e['level'] for e in effects}),
                    'expressionStatus': 'partial' if unresolved else 'complete', 'unresolved': unresolved,
                    'runtimeAdaptations': sorted({s for e in effects for s in e['runtimeAdaptations']})})
        return {'sourceVersion': self.version, 'sourceTablesHash': digest(self.t), 'modelVersion': 'skill-semantics-inventory-v4',
                'scope': 'five_skill_families_all_effect_levels_plus_parent_only_and_card_references',
                'releaseStatus': 'snapshot_records_not_proof_of_release', 'contracts': CONTRACTS, 'skills': records}


def combination_shapes(skill):
    """Parameter-only reuse requires the whole per-level effect combination.

    IDs, numerical strengths and selector values vary; operator enums,
    predicate polarity, selector field structure and budget modes do not.
    """
    def selectors(targets):
        return sorted({json.dumps([s['kind'], sorted(s.get('allOf', {}))]) for s in targets['selectors']})

    def effect_shape(e):
        return {'operation': e['operation']['code'], 'phase': e['timing']['phase'],
                'enumValue': e['operation']['value'] if e['operation']['unit'] in ['judgement_code', 'result_code_one_based'] else None,
                'targets': selectors(e['targets']),
                'conditions': {role: [[(c.get('code'), c.get('positive'), len(c.get('parameters', [])), selectors(c.get('targets', {'selectors': []})))
                                      for c in g['allOf']] for g in p['anyOf']] for role, p in e['conditions'].items()},
                'lifetime': [e['lifetime']['mode'], e['lifetime']['triggerType']],
                'budgets': [bool(e['budgets']['activationLimit']), bool(e['budgets']['perActivationEffectLimit'])],
                'cumulative': [e['cumulative'].get('code'), selectors(e['cumulative'].get('targets', {'selectors': []}))] if e['cumulative'] else None,
                'cumulativeEvaluation': e['cumulativeEvaluation']['mode'] if e['cumulativeEvaluation'] else None}

    return {digest([skill['family'], [effect_shape(e) for e in skill['effects'] if e['level'] == level]]) for level in skill['levels']}


def annotate(snapshot, baseline, combination_review=None):
    old = {s['key']: s for s in baseline['skills']}
    known_shapes = set().union(*(combination_shapes(s) for s in baseline['skills'] if s['expressionStatus'] == 'complete'))
    receipt = combination_review or {}
    hashes = receipt.get('codeAndTestHashes', {})
    fresh = bool(hashes) and receipt.get('sourceVersion') == snapshot['sourceVersion'] and all(
        (ROOT / path).is_file() and hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected
        for path, expected in hashes.items())
    reviewed = {r['key']: r for r in receipt.get('results', [])} if fresh else {}
    if combination_review:
        snapshot['combinationReviewReceipt'] = {'sourceVersion': receipt.get('sourceVersion'),
            'freshForThisSnapshot': fresh, 'codeAndTestHashes': hashes, 'scope': receipt.get('scope')}
    for skill in snapshot['skills']:
        base = old.get(skill['key'])
        identical = bool(base and [e['sourceClosureHash'] for e in base['effects']] == [e['sourceClosureHash'] for e in skill['effects']])
        skill['sameEffectClosureAsFormal'] = identical
        unknown = bool(skill['unresolved'])
        runtime = skill['runtimeAdaptations']
        # Novel combinations remain reviewable even when all atomic fields have names.
        review = [] if identical or unknown or combination_shapes(skill) <= known_shapes else ['new_combination_review']
        proof = reviewed.get(skill['key'])
        bound_proof = bool(proof and proof.get('cases', 0) > 0 and
                           proof.get('sourceClosureHashes') == [e['sourceClosureHash'] for e in skill['effects']])
        confirmed = bound_proof and proof.get('status') == 'implementation_confirmed'
        if confirmed and not unknown and not runtime:
            review = []
        if bound_proof and proof.get('status') == 'runtime_mismatch' and runtime and not unknown:
            review = []
        skill['mechanismReview'] = review
        native = []
        if (skill['family'] == 'GekisouSkill' and
                digest([e['sourceClosureHash'] for e in skill['effects']]) == NATIVE_CLOSURES.get(skill['skillId'])):
            native = [{'fields': ['lifetime', 'trigger_logic', 'install_time'],
                       'sourceClient': 'global-build-25',
                       'scope': 'same_path_parameter_inference' if skill['skillId'] == 12 else 'Lv5_direct_other_levels_same_path' if skill['skillId'] == 13 else 'all_5_levels_both_orders_within_300_update_fixture',
                       'fixture': 'gekisou-combo-threshold-native.json' if skill['skillId'] in [12, 13] else 'gekisou-life-combo-native.json',
                       'versionRelation': 'same_snapshot' if snapshot['sourceVersion'] == 'global-1.0.1-25-code-v6' else 'identical_data_not_new_client_verification'}]
        skill['evidence'] = {'dataDeclared': True, 'implementationMapping': 'source_inspected_not_full_skill_execution',
                             'nativeFieldEvidence': native, 'wholeSkillClientVerification': 'not_claimed',
                             'generalBoundary': 'mixed_scheduler_and_cross_version_client_evidence_scoped_separately'}
        identity_effects = [e['id'] for e in skill['effects'] if e['cumulativeEvaluation']]
        if identity_effects:
            native.append({'fields': ['cumulativeEvaluation', 'operation_component'], 'effectIds': identity_effects,
                'sourceClient': 'global-1.1.0-86', 'versionRelation': 'same_snapshot',
                'scope': 'native_ID_zero_branch_and_component_mapping_with_synthetic_inputs_not_whole_formation',
                'fixture': 'leader-cumulative-default-native.json'})
        if confirmed:
            skill['evidence']['combinationReview'] = proof
            skill['evidence']['implementationMapping'] = 'actual_rows_offline_probed_current_js'
        if bound_proof:
            skill['evidence']['combinationAudit'] = proof
        score_status = 'blocked' if unknown or runtime or review else 'conditional'
        skill['consumers'] = {
            'summary': {'status': 'partial' if unknown else 'derivable', 'integrated': False,
                        'missing': ['summary_templates'] + skill['unresolved']},
            'tags': {'status': 'partial' if unknown else 'derivable', 'integrated': False,
                     'missing': ['tag_rules'] + skill['unresolved']},
            'score': {'status': score_status, 'integrated': False,
                      'missing': ['score_semantic_adapter'] + skill['unresolved'] + runtime + review,
                      'context': ['formation/growth', 'chart_and_mode', 'effective_judgements_or_raw_timing', 'clock/skill_order/random/rank_when_applicable']},
            'team': {'status': score_status, 'integrated': False,
                     'missing': ['team_semantic_adapter'] + skill['unresolved'] + runtime + review,
                     'scope': 'per_candidate; excluded_candidates_preclude_full_pool_optimum'},
        }
        for consumer in skill['consumers'].values():
            consumer['missingDetails'] = {code: describe(code) for code in consumer['missing']}
        skill['onboarding'] = 'mechanism_confirmation' if unknown else 'runtime_adaptation' if runtime else 'combination_review' if review else 'verified_existing_implementation' if confirmed else 'parameter_import_candidate_after_consumer_integration'
        skill['tagsPreview'] = sorted({e['operation']['label'] for e in skill['effects'] if e['operation']['name'] != 'unresolved'} | {
            PREDICATES[c['code']] for e in skill['effects'] for p in e['conditions'].values() for g in p['anyOf'] for c in g['allOf'] if c.get('code') in PREDICATES})
    snapshot['coverage'] = coverage(snapshot['skills'])


def coverage(skills):
    effects = [e for s in skills for e in s['effects']]
    referenced = [s for s in skills if s['references']]
    return {'definitions': len(skills), 'effects': len(effects),
            'effectBackedDefinitions': sum(bool(s['effects']) for s in skills),
            'completeDefinitions': sum(s['expressionStatus'] == 'complete' for s in skills),
            'completeEffects': sum(e['expressionStatus'] == 'complete' for e in effects),
            'referencedDefinitions': len(referenced),
            'completeReferencedDefinitions': sum(s['expressionStatus'] == 'complete' for s in referenced),
            'reachableEffects': sum(any(e['level'] in r['reachableLevels'] for r in s['references']) for s in skills for e in s['effects']),
            'runtimeMismatchDefinitions': sum(any('runtime_mismatch' in x for x in s['runtimeAdaptations']) for s in skills),
            'nativeFieldEvidenceDefinitions': sum(bool(s['evidence']['nativeFieldEvidence']) for s in skills),
            'offlineCombinationConfirmedDefinitions': sum('combinationReview' in s['evidence'] for s in skills),
            'offlineCombinationAuditedDefinitions': sum('combinationAudit' in s['evidence'] for s in skills),
            'wholeSkillClientVerifiedDefinitions': 0,
            'referencedOnboarding': dict(Counter(s['onboarding'] for s in referenced)),
            'consumers': {c: dict(Counter(s['consumers'][c]['status'] for s in skills)) for c in ['summary', 'tags', 'score', 'team']},
            'onboarding': dict(Counter(s['onboarding'] for s in skills)),
            'issuesByDefinition': dict(Counter(x for s in skills for x in set(s['unresolved'] + s['runtimeAdaptations'] + s['mechanismReview']))),
            'families': {f: {'definitions': len(ss), 'complete': sum(s['expressionStatus'] == 'complete' for s in ss),
                             'effects': sum(len(s['effects']) for s in ss), 'referenced': sum(bool(s['references']) for s in ss)}
                         for f in FAMILIES if (ss := [s for s in skills if s['family'] == f])}}


def effect_text(e):
    op = e['operation']
    def cond_text(program):
        return ' OR '.join('(' + ' AND '.join(
            ('NOT ' if not c.get('positive', True) else '') + str(c.get('predicate', '待确认')) +
            str(c.get('parameters', [])) + (f" target={c['raw']['_conditionTargetIDs']}" if c.get('raw', {}).get('_conditionTargetIDs') else '')
            for c in group['allOf']) + ')' for group in program['anyOf'])
    clauses = [f"{op['label']} {op['value']} {op['unit']}"]
    for role, program in e['conditions'].items():
        if program['anyOf']:
            clauses.append(role + '=' + cond_text(program))
    if e['targets']['selectors']:
        clauses.append('targets=' + json.dumps([s.get('allOf', {}) for s in e['targets']['selectors']], ensure_ascii=False))
    if e['cumulative']:
        c = e['cumulative']; clauses.append(f"累计 {c.get('source')} / {c.get('unitParameters')}，次数上限 {c.get('countCap')}，效果上限 {op['maximumValue']}")
    if e['cumulativeEvaluation']:
        clauses.append('累计条件 ID=0：恒等倍率 1，无人数计数器')
    clauses += [f"持续={e['lifetime']['mode']}({e['lifetime']['durationSeconds']}s)",
                f"发动上限={e['budgets']['activationLimit']}；每次额度={e['budgets']['perActivationEffectLimit']}（0=不限）"]
    return '；'.join(clauses)


def write_outputs(snapshots, output):
    output.mkdir(parents=True, exist_ok=True)
    summary = {s['sourceVersion']: s['coverage'] for s in snapshots}
    (output / 'coverage.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    md = ['# 统一技能语义清单', '', '全量逐效果语义见各版本 JSON；CSV 可筛选。本文为离线生成结果，权威契约见仓库 docs/reference/skill-semantics.md。', '',
          '**口径**：complete 表示所有效果字段已有设计解释；不表示正式消费方已接入或整场客户端已验收。计分／配队 conditional 还需请求上下文；blocked 记录具体原因。较新 Master 可能含未发布／占位记录。', '',
          '五个技能域各自编号，跨版本分别统计，不能把同 ID 合并。定义统计取效果、父表与非零卡片引用的并集。', '']
    for snap in snapshots:
        version = snap['sourceVersion']; cov = snap['coverage']
        (output / f'{version}.json').write_text(json.dumps(snap, ensure_ascii=False, indent=2) + '\n')
        with (output / f'{version}-skills.csv').open('w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f); writer.writerow(['版本', '技能', '类别', '等级', '效果行数', '引用卡片ID', '表达', '机制待确认', '执行适配', '组合审核', '摘要', '标签', '计分', '配队', '接入路线'])
            for s in snap['skills']:
                writer.writerow([version, s['key'], s['familyLabel'], ','.join(map(str, s['levels'])), len(s['effects']),
                    ','.join(str(r['cardId']) for r in s['references']), s['expressionStatus'], ';'.join(s['unresolved']),
                    ';'.join(s['runtimeAdaptations']), ';'.join(s['mechanismReview']),
                    *[s['consumers'][c]['status'] for c in ['summary', 'tags', 'score', 'team']], s['onboarding']])
        with (output / f'{version}-effects.csv').open('w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f); writer.writerow(['版本', '技能', '效果行', '等级', '表达', '机制待确认', '执行适配', '语义展开'])
            for s in snap['skills']:
                for e in s['effects']:
                    writer.writerow([version, s['key'], e['id'], e['level'], e['expressionStatus'], ';'.join(e['unresolved']), ';'.join(e['runtimeAdaptations']), effect_text(e)])
        md += [f'## {version}', '', f'[完整 JSON]({version}.json) · [逐技能 CSV]({version}-skills.csv) · [逐效果 CSV]({version}-effects.csv)', '',
               f"Master 修订：{snap.get('sourceMasterRevision', '未单独声明；以 sourceTablesHash 区分数据')}。", '',
               f"{cov['definitions']} 个定义（其中 {cov['effectBackedDefinitions']} 个有效果），{cov['effects']} 条效果；完整表达 {cov['completeDefinitions']}/{cov['definitions']}，效果完整表达 {cov['completeEffects']}/{cov['effects']}。", '',
               f"被卡片引用的定义 {cov['referencedDefinitions']}，其中完整 {cov['completeReferencedDefinitions']}；按留影 rank 等级可达效果 {cov['reachableEffects']}。这些记录不构成已上线卡片清单。", '',
               '| 类别 | 定义 | 完整 | 效果行 | 被引用定义 |', '| --- | ---: | ---: | ---: | ---: |']
        md += [f"| {FAMILIES[k][0]} | {v['definitions']} | {v['complete']} | {v['effects']} | {v['referenced']} |" for k, v in cov['families'].items()]
        md += ['', '### 消费方与接入路线', '', '全部消费方的统一语义接入均未实施；下表是设计可用性，不是线上支持率。', '']
        md += [f"- {c}：{json.dumps(v, ensure_ascii=False)}" for c, v in cov['consumers'].items()]
        md += ['', '接入路线：' + json.dumps(cov['onboarding'], ensure_ascii=False), '', '### 缺口（同一技能可命中多项）', '']
        md += [f'- `{k}`：{v} 个定义；{describe(k)}' for k, v in sorted(cov['issuesByDefinition'].items())]
        audited = [s for s in snap['skills'] if 'combinationAudit' in s['evidence']]
        if audited:
            md += ['', '### 已登记的实际组合离线核对', '',
                   '以下证据来自未修改的当前 JavaScript 执行器与合成输入；解除组合待审核状态后，计分／配队仍须请求级判定。没有新增客户端原生或整场实机结论。', '',
                   '| 技能 | 结论 | 等级 | 效果行 | 离线用例 | 已核对环节 |', '| --- | --- | --- | ---: | ---: | --- |']
            for s in audited:
                p = s['evidence']['combinationAudit']
                md.append(f"| {s['key']} | {p['status']} | {','.join(map(str, p['levels']))} | {p['effectRows']} | {p['cases']} | {'; '.join(p['checks'])} |")
        md += ['', '### 逐技能索引', '', '| 技能 | 完整表达 | 引用卡片 ID | 摘要/标签 | 计分/配队 | 缺口 |', '| --- | --- | --- | --- | --- | --- |']
        for s in snap['skills']:
            md.append(f"| {s['key']} | {s['expressionStatus']} | {','.join(str(r['cardId']) for r in s['references']) or '无'} | {s['consumers']['summary']['status']} | {s['consumers']['score']['status']} | {'; '.join(s['unresolved'] + s['runtimeAdaptations'] + s['mechanismReview']) or '统一消费方接入、上下文判定'} |")
        md += ['', '### 代表技能语义展开', '']
        examples = {'LeaderSkill:53', 'LeaderSkill:63', 'LeaderSkill:64', 'LeaderSkill:65', 'LeaderSkill:90088', 'LeaderSkill:90089', 'LeaderSkill:90090', 'LeaderSkill:90124', 'LiveSkill:1', 'SupportSkill:61', 'GekisouSkill:13', 'GekisouSkill:16', 'GekisouSkill:18', 'GekisouSkill:19', 'GekisouSkill:24', 'GekisouSupportSkill:76'}
        for s in snap['skills']:
            if s['key'] not in examples:
                continue
            md += [f"#### {s['key']}", '', f"表达：{s['expressionStatus']}；计分／配队：{s['consumers']['score']['status']}。", '']
            md += [f"- Lv.{e['level']} 效果 {e['id']}：{effect_text(e)}" for e in s['effects'] if e['level'] == max(s['levels'])]
            if not s['effects']:
                md += ['- 父定义存在，效果数据缺失；保留为空缺，不推定为无效果。']
            md += ['']
    md += ['## 通用消费方适配', ''] + [f'- `{k}`：{REASONS[k]}' for k in ['summary_templates', 'tag_rules', 'score_semantic_adapter', 'team_semantic_adapter']]
    (output / 'inventory.md').write_text('\n'.join(md) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rules', type=Path, default=ROOT / 'packages/scoring/data/formal-scoring-rules.json')
    parser.add_argument('--master', type=Path)
    parser.add_argument('--master-version')
    parser.add_argument('--master-revision', help='Official Master revision; distinct from the client/rule version')
    parser.add_argument('--combination-review', type=Path, help='Offline probe receipt; stale code or data never clears review')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.master and not args.master_version:
        parser.error('--master requires --master-version')
    rules = json.loads(args.rules.read_text())
    review = json.loads(args.combination_review.read_text()) if args.combination_review else None
    baseline = Inventory(rules['tables'], rules['ruleSetVersion']).build()
    annotate(baseline, baseline, review)
    snapshots = [baseline]
    if args.master:
        names = set(FAMILIES) | {f + 'Effect' for f in FAMILIES} | {'SkillConditionSet', 'SkillCondition', 'SkillTarget', 'SkillCumulativeCondition', 'SkillEffectSetting', 'MemberCard', 'SupportCard', 'SupportCardRank'}
        tables = {name: json.loads(path.read_text())['_allData'] for name in sorted(names) if (path := args.master / f'Master{name}.json').exists()}
        snap = Inventory(tables, args.master_version).build()
        if args.master_revision:
            snap['sourceMasterRevision'] = args.master_revision
        annotate(snap, baseline, review); snapshots.append(snap)
    write_outputs(snapshots, args.output)
    print(json.dumps({s['sourceVersion']: s['coverage'] for s in snapshots}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
