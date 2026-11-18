"""Build 25 native COMBO/LIFE AND, paired sustained effects and command order.

Private client inputs stay external. Synthetic snapshots and container storage
are explicit; condition comparisons, NOT/AND, trigger timestamps, lifetimes and
applier traversal execute intact ARM64 instructions. No Unity/game connection.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

from crypto.native_scoring_harness import NativeHarness, CLIENT_SHA, DECODED_SHA
from unicorn.arm64_const import UC_ARM64_REG_PC, UC_ARM64_REG_S0

METHODS = dict(combo=0x55ed6a0, lifeBase=0x55f10e4, lifeGreaterEqual=0x55f1428,
               negate=0x55f653c, conjunction=0x55f61b0,
               defaultOverride=0x55f1084, defaultTime=0x55f108c,
               trigger=0x561b3dc, sustained=0x561e660, effect=0x561f554,
               applier=0x55ff1e0, applierController=0x560da10)


class PairProbe:
    def __init__(self, client, decoded, rows, tables, reverse=False):
        self.h = h = NativeHarness(client=client, decoded=decoded)
        self.current = dict(combo=0, life=1000, now=1000, last=970)
        self.commands, self.pool, self.changed = [], [], []
        self.handles, self.live, self.bindings = {}, {}, {}
        self.effects = []
        self.klass = h.alloc(0x200)
        h.i32(self.klass + 0xe4, 1)
        h.write(self.klass + 0x130, b'\x01')
        hierarchy = h.alloc()
        h.u64(hierarchy, self.klass)
        h.u64(self.klass + 0xc8, hierarchy)
        # LifeCheckerBase dispatches the concrete >= comparison virtually.
        h.u64(self.klass + 0x1d8, METHODS['lifeGreaterEqual'])
        token = self.obj()
        for address in [0xc5362c0, 0xc5362d8, 0xc536c00, 0xc537040, 0xc537388,
                        0xc537440, 0xc5379c0, 0xc5377f8, 0xc5382c0, 0xc5383d0,
                        0xc537470, 0xc537478, 0xc537480, 0xc537488, 0xc531528,
                        0xc533408, 0xc537038, 0xc536e40, 0xc537048, 0xc537050,
                        0xc537058, 0xc537458, 0xc5377e8, 0xc5377f0]:
            h.u64(address, token)
        h.callbacks[0x53d52c0] = lambda vm: vm.ret()
        h.callbacks[0x53d5264] = lambda vm: vm.ret()
        h.callbacks[0x5412b78] = lambda vm: vm.ret(self.bindings[vm.reg(0), vm.reg(2)])
        h.callbacks[0x55d1548] = lambda vm: self.span(vm, vm.reg(0))
        for address in [0x53d5574, 0x53d557c, 0x56213bc]:
            h.callbacks[address] = self.fail

        self.frame, controller, range_state = [self.obj() for _ in range(3)]
        self.bind(self.frame, 0, lambda vm: vm.ret(self.current['now']))
        self.bind(self.frame, 14, lambda vm: vm.ret(100000))
        self.bind(controller, 2, lambda vm: vm.ret(0))
        self.bind(controller, 14, lambda vm: vm.ret(range_state))
        self.bind(range_state, 11, lambda vm: vm.ret(self.current['combo']))
        self.bind(range_state, 17, lambda vm: vm.ret(self.current['last']))
        h.callbacks[0x4d834a8] = lambda vm: vm.ret(self.current['last'])
        combo_delegate, life_delegate = self.obj(), self.obj()
        h.u64(combo_delegate + 0x18, h.stub(lambda vm: vm.ret(controller)))
        h.u64(life_delegate + 0x18, h.stub(lambda vm: vm.ret(self.current['life'])))

        for row in rows:
            sets = [s for s in tables['SkillConditionSet'] if s['_group'] == row['_skillTriggerConditionGroup']]
            assert len(sets) == 1
            conditions = [next(c for c in tables['SkillCondition'] if c['_id'] == cid) for cid in sets[0]['_conditionIds']]
            assert [c['_conditionType'] for c in conditions] == [7005, 2001]
            assert conditions[0]['_conditionValues'] == [1] and conditions[0]['_isPositive']
            assert row['_skillTriggerType'] == 2 and row['_activationTimeSecond'] == 0
            for field in ['_skillConditionGroup', '_skillReleaseConditionGroup', '_effectExecuteLimitCount',
                          '_effectExecuteLimitResetConditionGroup', '_skillCumulativeConditionID', '_effectLimitCount']:
                assert row[field] == 0
            combo, life, parameter, negate, conjunction, trigger = [self.obj() for _ in range(6)]
            h.u64(combo + 0x10, combo_delegate)
            h.i32(combo + 0x18, 1)
            self.bind(combo, 0, METHODS['combo'])
            h.u64(life + 0x10, life_delegate)
            h.u64(life + 0x18, parameter)
            threshold = conditions[1]['_conditionValues'][0]
            self.bind(parameter, 0, lambda vm, v=threshold: vm.ret(v))
            self.bind(life, 0, METHODS['lifeBase'])
            h.u64(negate + 0x10, life)
            self.bind(negate, 0, METHODS['negate'])
            children = self.array([combo, life if conditions[1]['_isPositive'] else negate])
            h.i32(conjunction + 0x10, 1)  # AND, as CreateAndChecker constructs
            h.u64(conjunction + 0x18, children)
            h.u64(conjunction + 0x20, self.array([0, 0]))  # neither child is an interval counter
            h.u64(conjunction + 0x28, self.array([]))
            self.bind(conjunction, 0, METHODS['conjunction'])
            self.bind(conjunction, 2, METHODS['defaultOverride'])
            self.bind(conjunction, 3, METHODS['defaultTime'])
            h.u64(trigger + 0x10, conjunction)
            definition, state, updater, wrapper, pool, result = [self.obj() for _ in range(6)]
            self.bind(definition, 14, lambda vm: vm.ret(12000))
            self.bind(definition, 15, self.zero_duration)
            self.bind(definition, 16, lambda vm, v=row['_effectValue']: vm.ret(v))
            h.u64(updater + 0x10, definition)
            h.u64(updater + 0x18, state)
            self.bind(updater, 0, 0x561f358)
            self.bind(updater, 4, METHODS['effect'])
            self.bind(state, 0, lambda vm, v=row['_id']: vm.ret(v))
            self.bind(state, 2, lambda vm, v=definition: vm.ret(v))
            for slot, offset in [(3, 0x2c), (4, 0x30), (5, 0x34)]:
                self.bind(state, slot, lambda vm, p=state, o=offset: vm.ret(vm.i32(p + o)))
            h.u64(wrapper + 0x18, pool)
            h.u64(wrapper + 0x30, result)
            self.effects.append(dict(row=row, trigger=trigger, state=state, wrapper=wrapper,
                                     updater=updater, pool=pool, high=conditions[1]['_isPositive'], threshold=threshold,
                                     previous=False))
        if reverse:
            self.effects.reverse()
        h.callbacks[0x8f3d960] = self.get_pool
        h.callbacks[0x8f3d7d0] = self.release_pool
        h.callbacks[0x561feb0] = lambda vm: (self.changed.append(vm.reg(1)), vm.ret())

        applier, sink, dictionary, container = [self.obj() for _ in range(4)]
        self.applier_controller, self.applier_input = self.obj(), self.obj()
        self.changed_array = self.array([0, 0])
        self.bind(self.applier_input, 3, lambda vm: self.span(vm, self.changed_array))
        self.bind(applier, 0, METHODS['applier'])
        h.u64(self.applier_controller + 0x10, container)
        h.u64(applier + 0x10, sink)
        h.u64(applier + 0x18, dictionary)
        h.callbacks[0x560d188] = lambda vm: (vm.uc.mem_write(vm.reg(2), struct.pack('<Q', applier)), vm.ret(1))
        self.bind(sink, 0, self.add)
        self.bind(sink, 1, self.remove)
        h.callbacks[0x7a90060] = lambda vm: (self.handles.__setitem__(vm.reg(1), vm.reg(2)), vm.ret())
        h.callbacks[0x7a8ffc0] = lambda vm: vm.ret(self.handles[vm.reg(1)])

    def obj(self):
        pointer = self.h.alloc()
        self.h.u64(pointer, self.klass)
        return pointer

    def array(self, values):
        pointer = self.h.alloc(0x20 + 8 * len(values))
        self.h.u64(pointer, self.klass)
        self.h.i32(pointer + 0x18, len(values))
        for i, value in enumerate(values):
            self.h.u64(pointer + 0x20 + i * 8, value)
        return pointer

    def bind(self, owner, slot, callback):
        pointer = self.h.alloc(16)
        self.h.u64(pointer, callback if isinstance(callback, int) else self.h.stub(callback))
        self.bindings[owner, slot] = pointer

    @staticmethod
    def span(vm, pointer):
        vm.reg(1, vm.i32(pointer + 0x18))
        vm.ret(pointer + 0x20)

    @staticmethod
    def zero_duration(vm):
        vm.uc.reg_write(UC_ARM64_REG_S0, 0)
        vm.ret()

    @staticmethod
    def fail(vm):
        raise RuntimeError(f'native exception at {vm.uc.reg_read(UC_ARM64_REG_PC):#x}')

    def get_pool(self, vm):
        effect = next(e for e in self.effects if e['pool'] == vm.reg(0))
        self.pool.append(dict(action='get', effectId=effect['row']['_id']))
        vm.ret(effect['updater'])

    def release_pool(self, vm):
        effect = next(e for e in self.effects if e['pool'] == vm.reg(0))
        self.pool.append(dict(action='release', effectId=effect['row']['_id']))
        vm.ret()

    def add(self, vm):
        value = struct.unpack('<f', struct.pack('<I', vm.uc.reg_read(UC_ARM64_REG_S0)))[0]
        handle = len(self.commands) + 1
        self.live[handle] = value
        self.commands.append(dict(action='add', timeMs=vm.reg(1), value=value, handle=handle))
        vm.ret(handle)

    def remove(self, vm):
        handle = vm.reg(2)
        value = self.live.pop(handle)
        self.commands.append(dict(action='remove', timeMs=vm.reg(1), value=value, handle=handle))
        vm.ret()

    def step(self, combo, life, now, last):
        h = self.h
        self.current.update(combo=combo, life=life, now=now, last=last)
        before = len(self.commands)
        self.changed.clear()
        # ConditionSkillUpdater caches all triggers before visiting effect rows.
        triggers, hits = [], []
        for effect in self.effects:
            triggers.append(h.call(METHODS['trigger'], effect['trigger'], self.frame))
            hits.append(h.reg(1))  # SkillExecuteTriggerResult.HitCount, NOT a timestamp
        expected_commands = []
        for effect, packed, hit_count in zip(self.effects, triggers, hits):
            expected = combo >= 1 and ((life >= effect['threshold']) == effect['high'])
            assert bool(packed & 1) == expected
            assert hit_count == int(expected)
            assert packed >> 32 == now, (packed >> 32, now, last)
            h.call(METHODS['sustained'], effect['wrapper'], self.frame, packed)
            if expected != effect['previous']:
                expected_commands.append(('add' if expected else 'remove', effect['row']['_effectValue']))
            expected_phase = (3 if effect['previous'] else 2) if expected else (4 if effect['previous'] else 0)
            assert h.i32(effect['state'] + 0x2c) == expected_phase
            effect['previous'] = expected
        states = [e['state'] for eid in self.changed for e in self.effects if e['row']['_id'] == eid]
        h.i32(self.changed_array + 0x18, len(states))
        for i, state in enumerate(states):
            h.u64(self.changed_array + 0x20 + 8 * i, state)
        h.call(METHODS['applierController'], self.applier_controller, self.applier_input)
        expected_bonus = sum(e['row']['_effectValue'] for e in self.effects
                             if combo >= 1 and ((life >= e['threshold']) == e['high']))
        assert sum(self.live.values()) == expected_bonus, (self.current, self.live, expected_bonus)
        emitted = self.commands[before:]
        assert [(c['action'], c['value']) for c in emitted] == expected_commands
        assert all(c['timeMs'] == now for c in emitted), emitted
        return dict(**self.current, phases={e['row']['_id']: h.i32(e['state'] + 0x2c) for e in self.effects},
                    triggerHitCounts=hits, activeBonus=sum(self.live.values()), commands=emitted)


def verify(client, decoded):
    rules = json.loads((Path(__file__).resolve().parents[2] / 'packages/scoring/data/formal-scoring-rules.json').read_text())
    results = []
    for skill in [18, 19]:
        for level in range(1, 6):
            rows = [r for r in rules['tables']['GekisouSkillEffect'] if r['_gekisouSkillID'] == skill and r['_level'] == level]
            assert len(rows) == 2
            for reverse in [False, True]:
                probe = PairProbe(client, decoded, rows, rules['tables'], reverse)
                try:
                    threshold = probe.effects[0]['threshold']
                    inputs = [(0, threshold), (1, threshold), (2, threshold - 1), (2, threshold),
                              (0, threshold - 1), (1, threshold), (0, threshold), (1, threshold - 1),
                              (1, threshold), (1, threshold + 1), (0, threshold - 1), (0, threshold),
                              (1, threshold - 1), (1, threshold), (0, threshold)]
                    frames = [probe.step(combo, life, 1010 + i * 10, 970 + i * 10)
                              for i, (combo, life) in enumerate(inputs)]
                    results.append(dict(skillId=skill, level=level, effectOrder=[e['row']['_id'] for e in probe.effects],
                                        frames=frames, pool=probe.pool))
                finally:
                    probe.h.close()
    return dict(clientSha256=CLIENT_SHA, decodedSha256=DECODED_SHA, ruleSetVersion=rules['ruleSetVersion'],
                methods={k: hex(v) for k, v in METHODS.items()},
                substitutions=['IL2CPP metadata, interface bindings, object construction and GC barriers',
                               'current LIFE, prior task COMBO, last judgement and frame-clock getters',
                               'array spans, per-effect single-element pools, changed-state collection and handle dictionary',
                               'host dispatch of cached triggers and sustained updaters in both supplied effect orders',
                               'applier lookup and add/remove command sinks'],
                scope='native compound predicates, trigger time, paired lifetime and applier traversal; supplied snapshots/orders, not Unity scheduling or whole-song scoring',
                cases=results)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', type=Path, required=True)
    parser.add_argument('--decoded', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.client, args.decoded)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(status='passed', cases=len(report['cases']), frames=sum(len(c['frames']) for c in report['cases']))))
