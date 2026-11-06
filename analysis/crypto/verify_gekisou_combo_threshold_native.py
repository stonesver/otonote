"""Replay build 25 COMBO threshold lifetime using intact ARM64 methods.

Private client paths are explicit. Fixtures supply interface getters, metadata,
object-pool/dictionary storage and command sinks. Comparison, trigger result,
sustained lifetime, effect state transitions and applier decisions run native.
This is not Unity scheduling, a full skill pool, or a whole-song score oracle.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

from crypto.native_scoring_harness import NativeHarness, CLIENT_SHA, DECODED_SHA
from unicorn.arm64_const import UC_ARM64_REG_PC, UC_ARM64_REG_S0

METHODS = {
    'condition': 0x55ed6a0,
    'trigger': 0x561b3dc,
    'sustainedUpdate': 0x561e660,
    'zeroDurationUpdate': 0x5620c4c,
    'effectUpdate': 0x561f554,
    'comboApplier': 0x55ff1e0,
}


def verify(client, decoded):
    rules = json.loads((Path(__file__).resolve().parents[2] /
                        'packages/scoring/data/formal-scoring-rules.json').read_text())
    row = next(r for r in rules['tables']['GekisouSkillEffect'] if r['_id'] == 65)
    assert (row['_gekisouSkillID'], row['_level'], row['_skillTriggerType'],
            row['_skillEffectType'], row['_activationTimeSecond'], row['_effectValue']) == (13, 5, 2, 12000, 0, 5)
    for field in ['_skillConditionGroup', '_skillReleaseConditionGroup', '_effectExecuteLimitCount',
                  '_effectExecuteLimitResetConditionGroup', '_skillCumulativeConditionID']:
        assert row[field] == 0
    sets = [s for s in rules['tables']['SkillConditionSet'] if s['_group'] == row['_skillTriggerConditionGroup']]
    assert len(sets) == 1 and len(sets[0]['_conditionIds']) == 1
    condition = next(c for c in rules['tables']['SkillCondition'] if c['_id'] == sets[0]['_conditionIds'][0])
    assert (condition['_conditionType'], condition['_conditionValues'], condition['_isPositive']) == (7005, [25], True)

    h = NativeHarness(client=client, decoded=decoded)
    try:
        # Static factory jump-table binding: 7005 selects the block which constructs
        # GekisouComboCountGreaterEqualChecker, not a max-combo or interval checker.
        assert 0x55f5624 + h.memory.read(0x2061330 + 5, 1)[0] * 4 == 0x55f5760
        klass = h.alloc(0x200)
        h.i32(klass + 0xe4, 1)
        h.write(klass + 0x130, b'\x01')
        hierarchy = h.alloc()
        h.u64(hierarchy, klass)
        h.u64(klass + 0xc8, hierarchy)

        def obj():
            pointer = h.alloc()
            h.u64(pointer, klass)
            return pointer

        h.callbacks[0x53d52c0] = lambda vm: vm.ret()  # metadata initialization
        h.callbacks[0x53d5264] = lambda vm: vm.ret()  # GC write barrier

        def fail(vm):
            raise RuntimeError(f'native exception at {vm.uc.reg_read(UC_ARM64_REG_PC):#x}')

        for address in [0x53d5574, 0x53d557c, 0x56213bc]:
            h.callbacks[address] = fail
        token = obj()
        for address in [0xc5362c0, 0xc5362d8, 0xc536c00, 0xc537040, 0xc537388,
                        0xc537440, 0xc5379c0, 0xc5377f8, 0xc5382c0, 0xc5383d0,
                        0xc537470, 0xc537478, 0xc537480, 0xc537488, 0xc531528]:
            h.u64(address, token)
        pairs = {}

        def bind(owner, slot, callback):
            entry = h.alloc(16)
            h.u64(entry, callback if isinstance(callback, int) else h.stub(callback))
            pairs[owner, slot] = entry

        h.callbacks[0x5412b78] = lambda vm: vm.ret(pairs[vm.reg(0), vm.reg(2)])
        (controller, range_state, checker, delegate, trigger, frame, definition,
         state, updater, wrapper, pool, result, applier, sink, dictionary) = [obj() for _ in range(15)]
        current = {'combo': 0, 'now': 1000, 'last': 999}
        commands, updates, pool_actions = [], [], []
        handles, live_handles = {}, {}
        h.u64(checker + 0x10, delegate)
        h.i32(checker + 0x18, condition['_conditionValues'][0])
        h.u64(delegate + 0x18, h.stub(lambda vm: vm.ret(controller)))
        bind(controller, 2, lambda vm: vm.ret(0))  # active range index
        bind(controller, 14, lambda vm: vm.ret(range_state))
        bind(range_state, 11, lambda vm: vm.ret(current['combo']))  # get_Combo, not slot 12 get_MaxCombo
        bind(range_state, 17, lambda vm: vm.ret(current['last']))
        h.callbacks[0x4d834a8] = lambda vm: vm.ret(current['last'])  # generic getter dispatch
        bind(checker, 0, METHODS['condition'])
        bind(checker, 2, 0x55ed5ac)
        bind(checker, 3, 0x55ed5bc)
        h.u64(trigger + 0x10, checker)
        bind(frame, 0, lambda vm: vm.ret(current['now']))
        bind(frame, 14, lambda vm: vm.ret(100000))

        def duration(vm):
            vm.uc.reg_write(UC_ARM64_REG_S0, 0)
            vm.ret()

        bind(definition, 15, duration)
        bind(definition, 16, lambda vm: vm.ret(row['_effectValue']))
        h.u64(updater + 0x10, definition)
        h.u64(updater + 0x18, state)
        bind(updater, 0, 0x561f358)
        bind(updater, 4, METHODS['effectUpdate'])
        bind(state, 0, lambda vm: vm.ret(65))
        bind(state, 2, lambda vm: vm.ret(definition))
        for slot, offset in [(3, 0x2c), (4, 0x30), (5, 0x34)]:
            bind(state, slot, lambda vm, offset=offset: vm.ret(vm.i32(state + offset)))
        h.u64(wrapper + 0x18, pool)
        h.u64(wrapper + 0x30, result)
        # Empty eligibility, zero duration and unbounded activations match row 65.
        # Outer executor routing trigger type 2 is established by static analysis.
        h.u64(wrapper + 0x38, 0)

        def get_pool(vm):
            pool_actions.append('get')
            vm.ret(updater)

        def release_pool(vm):
            pool_actions.append('release')
            vm.ret()

        h.callbacks[0x8f3d960] = get_pool
        h.callbacks[0x8f3d7d0] = release_pool
        h.callbacks[0x561feb0] = lambda vm: (updates.append(vm.reg(1)), vm.ret())
        h.u64(applier + 0x10, sink)
        h.u64(applier + 0x18, dictionary)

        def add(vm):
            value = struct.unpack('<f', struct.pack('<I', vm.uc.reg_read(UC_ARM64_REG_S0)))[0]
            handle = len(commands) + 1
            live_handles[handle] = value
            commands.append(dict(action='add', timeMs=vm.reg(1), value=value, handle=handle))
            vm.ret(handle)

        def remove(vm):
            handle = vm.reg(2)
            live_handles.pop(handle)
            commands.append(dict(action='remove', timeMs=vm.reg(1), handle=handle))
            vm.ret()

        bind(sink, 0, add)
        bind(sink, 1, remove)

        def save(vm):
            handles[vm.reg(1)] = vm.reg(2)
            vm.ret()

        h.callbacks[0x7a90060] = save
        h.callbacks[0x7a8ffc0] = lambda vm: vm.ret(handles[vm.reg(1)])
        rows = []
        # Repeated true is not another activation. False removes; next-frame true
        # may clean up and re-enter in the same update. Include 24, not only zero.
        combos = [24, 25, 30, 0, 0, 24, 25, 30, 24, 25, 30, 0, 25, 0, 24]
        expected_phases = [0, 2, 3, 4, 0, 0, 2, 3, 4, 2, 3, 4, 2, 4, 0]
        for combo, expected_phase in zip(combos, expected_phases):
            current.update(combo=combo, now=current['now'] + 10, last=current['now'] + 9)
            before = len(commands)
            updates.clear()
            packed = h.call(METHODS['trigger'], trigger, frame)
            h.call(METHODS['sustainedUpdate'], wrapper, frame, packed)
            if updates:
                h.call(METHODS['comboApplier'], applier, state)
            phase = h.i32(state + 0x2c)
            assert phase == expected_phase, (combo, phase, expected_phase)
            assert bool(packed & 1) == (combo >= 25)
            assert sum(live_handles.values()) == (5 if combo >= 25 else 0)
            emitted = commands[before:]
            assert [c['action'] for c in emitted] == ({2: ['add'], 4: ['remove']}.get(phase, []))
            if emitted:
                assert emitted[0]['timeMs'] == (current['last'] if phase == 2 else current['now'])
            rows.append(dict(combo=combo, trigger=bool(packed & 1), phase=phase,
                             activeBonus=sum(live_handles.values()), commands=emitted))
        assert pool_actions == ['get', 'release'] * 4
        return dict(clientSha256=CLIENT_SHA, decodedSha256=DECODED_SHA,
                    ruleSetVersion=rules['ruleSetVersion'], effectId=65,
                    methods={key: hex(value) for key, value in METHODS.items()},
                    scope='native condition/trigger/sustained updater/effect updater/applier; synthetic prior-frame counts, not full Unity scheduling or score replay',
                    substitutions=['IL2CPP metadata, interface dispatch and GC barriers',
                                   'current range, current COMBO, last-note time and frame clock getters',
                                   'zero duration and +5 effect getters; empty eligibility, no release, unlimited activation budget',
                                   'one-element updater pool and effect-to-handle dictionary storage',
                                   'changed-effect result collector and add/remove command sink'],
                    rows=rows, pool=pool_actions)
    finally:
        h.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', type=Path, required=True)
    parser.add_argument('--decoded', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.client, args.decoded)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'nativeFrames': len(report['rows']), 'poolTransitions': len(report['pool']), 'status': 'passed'}))
