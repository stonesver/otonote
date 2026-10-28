"""Bounded JP 1.1.0 ARM64 oracle with synthetic formation/judgement counts.

Private inputs are required; no game binaries, Master rows or device logs are
emitted. Original leader slot-count loop/cap, effect multiplication/component
accumulation and judgement floor division execute intact. Host substitutions
are explicit. This does not execute Unity's input scheduler or a whole live.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from unicorn.arm64_const import UC_ARM64_REG_PC
from crypto.native_scoring_harness import NativeHarness

CLIENT_SHA = '119a19de9dfae037e75b4443769247ac38df4f1e60e61031363aa1227be48d4e'
DECODED_SHA = '7bb4d5b33bb4df5feec269a766fe05628789d491fe0bbe2bb5a001aa345dda77'


def verify(client, decoded):
    h = NativeHarness(client=client, decoded=decoded, client_sha=CLIENT_SHA, decoded_sha=DECODED_SHA)
    klass = h.alloc(0x200); h.i32(klass + 0xe4, 1)
    h.callbacks[0x53879f8] = lambda vm: vm.ret()
    h.callbacks[0x5387b78] = lambda vm: vm.ret()
    token = h.alloc(); h.u64(token, klass)
    h.u64(0xbfff898, token)
    formation, row, checker = h.alloc(), h.alloc(), h.alloc()
    h.u64(formation, klass)
    count_token, item_token = h.alloc(), h.alloc()
    h.u64(count_token, 1); h.u64(item_token, 2); h.u64(0xc022620, item_token)
    values = []
    count_entry, item_entry = h.alloc(), h.alloc()
    h.u64(count_entry, h.stub(lambda vm: vm.ret(len(values))))
    h.u64(item_entry, h.stub(lambda vm: vm.ret(values[vm.reg(1)])))
    h.callbacks[0x53c122c] = lambda vm: vm.ret(count_entry if vm.reg(1) == 1 else item_entry)
    h.callbacks[0x589d9f4] = lambda vm: vm.ret(vm.reg(0) == 2)
    # Stop bounded blocks before their caller-owned epilogues.
    h.observers[0x589d02c] = lambda vm: vm.uc.reg_write(UC_ARM64_REG_PC, vm.stop)
    leaders = []
    print("native leader loop", flush=True)
    for mask in range(32):
        values[:] = [2 if mask & (1 << i) else 1 for i in range(5)]
        for maximum in [1, 2, 3, 0]:
            h.i32(row + 0x38, maximum)
            h.reg(19, formation); h.reg(20, row); h.reg(21, 0); h.reg(24, count_token)
            count = h.call(0x589cb48)
            expected = min(mask.bit_count(), maximum) if maximum else mask.bit_count()
            assert count == expected
            leaders.append(dict(attributes=list(values), maximum=maximum, expected=count))
    del h.observers[0x589d02c]
    # GetEffectValue uses the cumulative count produced by the original loop.
    effect = h.alloc(); h.i32(effect + 0x3c, 2400); h.i32(effect + 0x40, 1)
    components = [h.alloc(4) for _ in range(3)]
    effects = []
    print("native leader effects", flush=True)
    for count in range(3):
        h.callbacks[0x589c70c] = lambda vm, n=count: vm.ret(n)
        for kind in range(1500, 1504):
            h.i32(effect + 0x38, kind)
            value = h.call(0x589c45c, effect, formation, 2, 0)
            for pointer in components: h.i32(pointer, 0)
            h.call(0x589c668, kind, value, *components)
            result = [h.i32(pointer) for pointer in components]
            effects.append(dict(kind=kind, count=count, value=value, expected=result))
    divisions = []
    h.observers[0x55c530c] = lambda vm: vm.uc.reg_write(UC_ARM64_REG_PC, vm.stop)
    print("native division", flush=True)
    for unit in [2, 4]:
        for count in range(65):
            h.i32(checker + 0x30, count); h.reg(19, checker)
            value = h.call(0x55c52a4, unit)
            assert value == count // unit
            divisions.append(dict(count=count, unit=unit, expected=value))
    h.close()
    return dict(clientSha256=CLIENT_SHA, decodedSha256=DECODED_SHA, leaders=leaders, effects=effects, divisions=divisions,
                substitutions=['IL2CPP metadata setup and interface dispatch', 'synthetic generic formation Count/index access',
                               'synthetic attribute membership predicate', 'GetEffectValue cumulative getter returns a previously native-verified count'],
                scope='bounded numerical blocks and leader count loop; not Unity scheduling, target resolution or full gameplay')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', type=Path, required=True)
    parser.add_argument('--decoded', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.client, args.decoded)
    args.output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    print(json.dumps({key: len(result[key]) for key in ['leaders', 'effects', 'divisions']}))
