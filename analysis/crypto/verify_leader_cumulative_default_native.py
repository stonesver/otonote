"""Offline build-86 leader identity multiplier and mission-target oracle.

Requires reviewed private client and patch inputs. Executes intact ARM64
methods with synthetic objects; does not launch the game or calculate a song.
Optional Master inputs check the 15 actual rows but must produce private output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from crypto.native_scoring_harness import NativeHarness

CLIENT_SHA = '157612380d055a604d40d294017fb1b3f27e91f01a56cd077e58db7019589f68'
DECODED_SHA = 'e647d26e05bacdf26b2735ecdc1019ee05aa67b8b7ed13740a9ced2d506fd34a'
PATCHES = {
    '49067fdb5b6e55b5334cdba8cf9f66fce0655978bfa5b1aa7d29a3b923ccacc3':
        '5666db811d8e3ba65a029e9f62048cff2798ea3d29d2f4c8016b005d6e064f44',
    '79af66ff04ae4ea801a7976fa9718c9d57236081ea61f0c1da08b05beb7c8aa1':
        '704e4e026ffdc45001609f23e1167608c8d368e4a777e2d38dd77730548ff24a',
}


def verify(client, decoded, patch, parsed_patch, master=None):
    patch_sha = hashlib.sha256(patch.read_bytes()).hexdigest()
    parsed_sha = PATCHES[patch_sha]
    assert hashlib.sha256(parsed_patch.read_bytes()).hexdigest() == parsed_sha
    fixes = json.loads(parsed_patch.read_text())['fixes']
    assert not any('LeaderSkillBonusCalculator' in f['type'] for f in fixes)
    h = NativeHarness(client=client, decoded=decoded, client_sha=CLIENT_SHA, decoded_sha=DECODED_SHA)
    h.callbacks[0x55e3ad0] = lambda vm: vm.ret()  # IL2CPP metadata initialization
    h.callbacks[0x63adf2c] = lambda vm: vm.ret(0)  # audited patch has no relevant replacement
    default_count = h.call(0x648b288, 0, 0, 0, 0)
    assert default_count == 1  # no loader or formation object is read
    effect = h.alloc()
    h.u64(effect + 0x40, 0)
    components = [h.alloc(8) for _ in range(3)]

    def evaluate(kind, value):
        h.i32(effect + 0x38, kind)
        h.i32(effect + 0x3c, value)
        actual = h.call(0x648ae28, effect, 0, 0, 0)
        assert actual == value
        for pointer in components:
            h.u64(pointer, 0)
        h.call(0x648b118, kind, actual, *components)
        result = [h.u64(pointer) for pointer in components]
        expected = [value if kind == 1500 or i == {1501: 1, 1502: 2, 1503: 0}.get(kind) else 0 for i in range(3)]
        assert result == expected
        return dict(opcode=kind, value=value, multiplier=default_count, components=result)

    values = [evaluate(kind, value) for kind in range(1500, 1504) for value in [0, 2400, 10000]]
    klass = h.alloc(0x200)
    member = h.alloc()
    h.u64(member, klass)
    token = h.alloc()
    h.u64(token, klass)
    h.u64(0xca89248, token)
    target = h.alloc()
    h.i32(target + 0x50, 2)  # sole target constraint: LUCK mission
    gekisou = h.alloc()
    entry, null_entry = h.alloc(), h.alloc()
    h.u64(entry, h.stub(lambda vm: vm.ret(gekisou)))
    h.u64(null_entry, h.stub(lambda vm: vm.ret(0)))
    h.callbacks[0x5621388] = lambda vm: vm.ret(entry if vm.reg(2) == 29 else null_entry)
    h.callbacks[0x4f5a058] = lambda vm: vm.ret(gekisou)
    targets = []
    for mission in range(4):
        h.i32(gekisou + 0x38, mission)
        matched = bool(h.call(0x648caec, member, target))
        assert matched == (mission == 2)
        targets.append(dict(memberMission=mission, targetMission=2, matched=matched))
    report = dict(sourceClient='global-1.1.0-86', clientSha256=CLIENT_SHA, decodedSha256=DECODED_SHA,
                  patchSha256=patch_sha, parsedPatchSha256=parsed_sha, patchFixes=len(fixes), relevantPatchOverrides=0,
                  defaultCount=default_count, values=values, targets=targets,
                  substitutions=['IL2CPP metadata setup', 'no relevant IFix replacement, checked against pinned patch',
                                 'synthetic member interface getters; native category/mission comparison intact'],
                  scope='ID=0 short circuit, native GetEffectValue/AccumulateEffectBP and single mission target; not full formation or Unity gameplay')
    if master:
        rows = json.loads((master / 'MasterLeaderSkillEffect.json').read_text())['_allData']
        rows = [r for r in rows if r['_leaderSkillID'] in [90088, 90089, 90090]]
        assert len(rows) == 15
        assert {(r['_leaderSkillID'], r['_level']) for r in rows} == {(s, lv) for s in [90088, 90089, 90090] for lv in range(1, 6)}
        for row in rows:
            assert row['_skillEffectType'] == 1503 and row['_skillCumulativeConditionID'] == 0
        report['actualRows'] = [dict(skillId=r['_leaderSkillID'], level=r['_level'], effectId=r['_id'],
                                    result=evaluate(r['_skillEffectType'], r['_effectValue'])) for r in rows]
    h.close()
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['client', 'decoded', 'patch', 'parsed-patch', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--master', type=Path)
    args = parser.parse_args()
    result = verify(args.client, args.decoded, args.patch, args.parsed_patch, args.master)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(defaultCount=result['defaultCount'], valueCases=len(result['values']),
                         targetCases=len(result['targets']), actualRows=len(result.get('actualRows', [])))))
