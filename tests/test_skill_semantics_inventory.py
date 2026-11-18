"""Inventory acceptance: lossless coverage and conservative support boundaries."""
import copy
import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from analysis.build_skill_semantics_inventory import (
    FAMILIES, Inventory, ROOT, annotate, combination_shapes, source_key, write_outputs,
)


class SkillSemanticsInventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rules = json.loads((ROOT / 'packages/scoring/data/formal-scoring-rules.json').read_text())
        cls.tables = rules['tables']
        cls.inventory = Inventory(cls.tables, rules['ruleSetVersion']).build()
        annotate(cls.inventory, cls.inventory)
        cls.skills = {s['key']: s for s in cls.inventory['skills']}

    def test_all_rows_and_references_accounted_for_without_cross_domain_merge(self):
        for family, (_, table, fields) in FAMILIES.items():
            actual = [(s['skillId'], e['id'], e['level'], e['raw']) for s in self.inventory['skills']
                      if s['family'] == family for e in s['effects']]
            expected = [(r[source_key(family)], r['_id'], r['_level'], r) for r in self.tables[family + 'Effect']]
            self.assertEqual(sorted(actual), sorted(expected))
            refs = {(s['skillId'], r['cardId'], r['slot']) for s in self.inventory['skills']
                    if s['family'] == family for r in s['references']}
            self.assertEqual(refs, {(c[field], c['_id'], field) for c in self.tables[table]
                                    for field in fields if c[field]})
        self.assertEqual(len(self.skills), 214)
        self.assertEqual(self.inventory['coverage']['completeDefinitions'], 214)
        self.assertEqual(sum(len(s['effects']) for s in self.skills.values()), 1800)

    def test_known_combo_difference_blocks_calculation_not_summary(self):
        blocked = [s for s in self.skills.values() if s['consumers']['score']['status'] == 'blocked']
        self.assertEqual({s['key'] for s in blocked}, {f'GekisouSkill:{n}' for n in [12, 13, 18, 19]})
        self.assertEqual(sum(len(s['effects']) for s in blocked), 30)
        for s in blocked:
            self.assertEqual(s['expressionStatus'], 'complete')
            self.assertEqual(s['consumers']['summary']['status'], 'derivable')
            self.assertEqual(s['consumers']['team']['status'], 'blocked')
            self.assertFalse(s['consumers']['summary']['integrated'])
        single = self.skills['GekisouSkill:13']['effects'][-1]
        self.assertEqual(single['timing']['installTime'], 'last_combo_judgement')
        for e in self.skills['GekisouSkill:18']['effects']:
            self.assertEqual(e['timing']['installTime'], 'current_skill_update_root_AND')
            self.assertEqual(e['lifetime']['mode'], 'while_trigger_holds')
            self.assertEqual(len(e['conditions']['trigger']['anyOf'][0]['allOf']), 2)
        positive = {p['positive'] for e in self.skills['GekisouSkill:18']['effects']
                    for p in e['conditions']['trigger']['anyOf'][0]['allOf'] if p['code'] == 2001}
        self.assertEqual(positive, {True, False})

    def test_conversion_count_target_and_budget_are_independent(self):
        s = self.skills['GekisouSupportSkill:76']
        row = next(e for e in s['effects'] if e['id'] == 760)
        self.assertEqual({x['allOf']['judgement'] for x in row['targets']['selectors']}, {1, 2, 3, 4, 5})
        counter = row['intervalCounters'][0]
        self.assertEqual({x['allOf']['judgement'] for x in counter['targets']['selectors']}, {5})
        self.assertEqual(counter['unit'], 30)
        self.assertEqual(row['budgets']['activationLimit'], 4)
        self.assertEqual(row['budgets']['perActivationEffectLimit'], 1)
        self.assertTrue(row['conditions']['budgetReset']['anyOf'])

    def test_unknown_data_and_parent_only_stay_in_inventory(self):
        tables = copy.deepcopy(self.tables)
        row = copy.deepcopy(tables['LeaderSkillEffect'][0])
        row.update(_id=99001, _leaderSkillID=99001, _skillEffectType=0)
        tables['LeaderSkillEffect'].append(row)
        parent = copy.deepcopy(tables['GekisouSkill'][0]); parent['_id'] = 99001
        tables['GekisouSkill'].append(parent)
        tables['MemberCard'][0]['_gekisouSkillID'] = 99001
        changed = Inventory(tables, 'synthetic').build(); annotate(changed, self.inventory)
        ss = {s['key']: s for s in changed['skills']}
        self.assertEqual(ss['LeaderSkill:99001']['expressionStatus'], 'partial')
        self.assertIn('unknown_operator:0', ss['LeaderSkill:99001']['unresolved'])
        self.assertIn('missing_effects', ss['GekisouSkill:99001']['unresolved'])
        self.assertEqual(ss['GekisouSkill:99001']['references'][0]['cardId'], 1)
        self.assertEqual(ss['GekisouSkill:99001']['consumers']['team']['status'], 'blocked')

    def test_new_values_reuse_shape_but_new_conditions_do_not(self):
        tables = copy.deepcopy(self.tables)
        for row in tables['LiveSkillEffect']:
            if row['_liveSkillID'] == 1:
                row['_effectValue'] += 100
        variant = Inventory(tables, 'synthetic-parameter-change').build(); annotate(variant, self.inventory)
        s = next(s for s in variant['skills'] if s['key'] == 'LiveSkill:1')
        self.assertFalse(s['sameEffectClosureAsFormal'])
        self.assertEqual(s['onboarding'], 'parameter_import_candidate_after_consumer_integration')
        original = copy.deepcopy(self.skills['GekisouSkill:18'])
        changed = copy.deepcopy(original)
        changed['effects'][0]['conditions']['trigger']['anyOf'][0]['allOf'][0]['positive'] ^= True
        self.assertNotEqual(combination_shapes(original), combination_shapes(changed))

    def test_native_evidence_is_bound_to_audited_data_not_skill_id(self):
        self.assertTrue(self.skills['GekisouSkill:13']['evidence']['nativeFieldEvidence'])
        tables = copy.deepcopy(self.tables)
        for row in tables['GekisouSkillEffect']:
            if row['_gekisouSkillID'] == 13:
                row['_effectValue'] += 1
        changed = Inventory(tables, self.inventory['sourceVersion']).build()
        annotate(changed, changed)
        skill = next(s for s in changed['skills'] if s['key'] == 'GekisouSkill:13')
        self.assertEqual(skill['evidence']['nativeFieldEvidence'], [])
        self.assertEqual(skill['consumers']['score']['status'], 'blocked')

    def test_member_target_sentinel_is_not_a_judgement_predicate(self):
        selectors = [x for s in self.skills.values() for e in s['effects'] for x in e['targets']['selectors']
                     if x['kind'] == 'member']
        self.assertTrue(selectors)
        for target in selectors:
            self.assertEqual(target['raw']['_judgement'], -1)
            self.assertNotIn('judgement', target['allOf'])

    def test_unverified_version_does_not_inherit_zero_cumulative_default(self):
        row = copy.deepcopy(self.tables['LeaderSkillEffect'][0])
        row.update(_skillEffectType=1503, _skillCumulativeConditionID=0)
        effect = Inventory(self.tables, 'synthetic').effect('LeaderSkill', row)
        self.assertEqual(effect['expressionStatus'], 'partial')
        self.assertIn('leader_cumulative_required', effect['unresolved'])
        self.assertIsNone(effect['cumulative'])
        self.assertEqual(effect['operation']['name'], 'power.performance.per_member')
        self.assertEqual(effect['raw']['_skillEffectType'], 1503)

    def test_build86_zero_cumulative_is_identity_but_runtime_still_blocks(self):
        tables = copy.deepcopy(self.tables)
        row = tables['LeaderSkillEffect'][0]
        row.update(_skillEffectType=1503, _skillCumulativeConditionID=0)
        snapshot = Inventory(tables, 'global-1.1.0-86').build()
        annotate(snapshot, self.inventory)
        skill = next(s for s in snapshot['skills'] if s['key'] == f"LeaderSkill:{row['_leaderSkillID']}")
        effect = next(e for e in skill['effects'] if e['id'] == row['_id'])
        self.assertEqual(effect['expressionStatus'], 'complete')
        self.assertIsNone(effect['cumulative'])
        self.assertEqual(effect['cumulativeEvaluation']['multiplier'], 1)
        self.assertIsNone(effect['cumulativeEvaluation']['counter'])
        self.assertEqual(effect['operation']['name'], 'power.performance')
        self.assertEqual(effect['operation']['code'], 1503)
        self.assertEqual(effect['raw']['_skillEffectType'], 1503)
        self.assertEqual(skill['consumers']['summary']['status'], 'derivable')
        self.assertEqual(skill['consumers']['tags']['status'], 'derivable')
        self.assertEqual(skill['consumers']['score']['status'], 'blocked')
        self.assertEqual(skill['consumers']['team']['status'], 'blocked')
        self.assertIn('leader_zero_cumulative_runtime_mismatch', skill['runtimeAdaptations'])
        self.assertIn('表演加成', skill['tagsPreview'])
        self.assertNotIn('按人数增加表演', skill['tagsPreview'])
        self.assertTrue(skill['evidence']['nativeFieldEvidence'])
        row['_skillCumulativeConditionID'] = 999999
        missing = Inventory(tables, 'global-1.1.0-86').effect('LeaderSkill', row)
        self.assertIsNone(missing['cumulativeEvaluation'])
        self.assertEqual(missing['expressionStatus'], 'partial')

    def test_identity_mapping_matches_persisted_native_component_oracle(self):
        fixture = json.loads((ROOT / 'site/tests/fixtures/leader-cumulative-default-native.json').read_text())
        row = copy.deepcopy(self.tables['LeaderSkillEffect'][0])
        model = Inventory(self.tables, fixture['sourceClient'])
        components = {'power.performance': 0, 'power.technic': 1, 'power.visual': 2}
        for case in fixture['values']:
            row.update(_skillEffectType=case['opcode'], _effectValue=case['value'], _skillCumulativeConditionID=0)
            effect = model.effect('LeaderSkill', row)
            value = effect['operation']['value'] * effect['cumulativeEvaluation']['multiplier']
            expected = [value if effect['operation']['name'] == 'power.all' or components.get(effect['operation']['name']) == i else 0 for i in range(3)]
            self.assertEqual(case['components'], expected)

    def test_review_receipt_only_clears_the_bound_combination(self):
        snapshot = copy.deepcopy(self.inventory)
        snapshot['sourceVersion'] = 'synthetic-review'
        skill = next(s for s in snapshot['skills'] if s['key'] == 'LiveSkill:1')
        # A changed stage makes this a new combination in the annotation test.
        skill['effects'][0]['timing']['phase'] = 99
        skill['effects'][0]['sourceClosureHash'] = 'changed-stage'
        annotate(snapshot, self.inventory)
        self.assertEqual(skill['mechanismReview'], ['new_combination_review'])
        path = 'scripts/verify_referenced_skill_combinations.mjs'
        receipt = {'sourceVersion': snapshot['sourceVersion'],
                   'codeAndTestHashes': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()},
                   'results': [{'key': skill['key'], 'status': 'implementation_confirmed', 'cases': 5,
                                'sourceClosureHashes': [e['sourceClosureHash'] for e in skill['effects']]}]}
        annotate(snapshot, self.inventory, receipt)
        self.assertEqual(skill['mechanismReview'], [])
        self.assertEqual(skill['onboarding'], 'verified_existing_implementation')
        self.assertEqual(skill['consumers']['score']['status'], 'conditional')
        self.assertFalse(skill['consumers']['score']['integrated'])
        self.assertEqual(skill['evidence']['nativeFieldEvidence'], [])
        for change in ['data', 'code', 'version', 'failed_probe', 'runtime_mismatch', 'unresolved']:
            variant, proof = copy.deepcopy(snapshot), copy.deepcopy(receipt)
            row = next(s for s in variant['skills'] if s['key'] == skill['key'])
            if change == 'data': row['effects'][0]['sourceClosureHash'] = 'another-change'
            if change == 'code': proof['codeAndTestHashes'][path] = 'stale'
            if change == 'version': proof['sourceVersion'] = 'other-version'
            if change == 'failed_probe': proof['results'][0]['status'] = 'needs_investigation'
            if change == 'runtime_mismatch': row['runtimeAdaptations'] = ['combo_threshold_lifetime_runtime_mismatch']
            if change == 'unresolved': row['unresolved'] = ['unknown_operator:99999']
            annotate(variant, self.inventory, proof)
            self.assertEqual(row['consumers']['score']['status'], 'blocked', change)

    def test_missing_reference_unknown_field_and_or_group_preserved(self):
        tables = copy.deepcopy(self.tables)
        tables['SkillConditionSet'].append({'_id': 99991, '_group': 99991, '_conditionIds': [99991]})
        tables['SkillConditionSet'].append({'_id': 99992, '_group': 99991, '_conditionIds': [99992]})
        tables['SkillCondition'].append({'_id': 99991, '_conditionType': 2001, '_conditionValues': [700], '_isPositive': False, '_conditionTargetIDs': []})
        row = copy.deepcopy(tables['LiveSkillEffect'][0]); row['_skillConditionGroup'] = 99991; row['_newMechanism'] = 5
        result = Inventory(tables, 'synthetic').effect('LiveSkill', row)
        self.assertEqual(result['expressionStatus'], 'partial')
        self.assertIn('missing_condition:99992', result['unresolved'])
        self.assertIn('unmapped_effect_field:_newMechanism', result['unresolved'])
        groups = result['conditions']['eligibility']['anyOf']
        self.assertEqual(len(groups), 2)
        self.assertFalse(groups[0]['allOf'][0]['positive'])

    def test_serialized_exports_have_every_skill_and_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory); write_outputs([self.inventory], output)
            version = self.inventory['sourceVersion']
            self.assertEqual(json.loads((output / f'{version}.json').read_text()), self.inventory)
            for suffix, expected in [('skills', 214), ('effects', 1800)]:
                with (output / f'{version}-{suffix}.csv').open(encoding='utf-8-sig', newline='') as f:
                    self.assertEqual(len(list(csv.DictReader(f))), expected)
            md = (output / 'inventory.md').read_text()
            self.assertIn('GekisouSkill:18', md)
            self.assertIn('不表示正式消费方已接入', md)


if __name__ == '__main__':
    unittest.main()
