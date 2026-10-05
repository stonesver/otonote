"""Bind reference calculations to content without inheriting a new client's audit.

Content updates reuse the implemented model with current Master parameters.
Only model changes need a mechanism review; source identities stay explicit.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from tools.build_formal_scoring_rules import ROOT, TABLES, project_tables

BASELINE = ROOT / 'packages/scoring/data/formal-scoring-rules.json'


def bind_reviewed_reference(master, release, base, profile):
    """A pinned data review enables estimates, never a new native audit."""
    unavailable = {'schemaVersion':1,'sourceReleaseId':release,'verificationStatus':'unavailable'}
    if profile['referenceNativeSha256'] != base['nativeSha256']:
        return {**unavailable,'reason':'reference_native_changed'}
    tables, hashes = project_tables(master)
    if hashes != profile['masterSha256']:
        return {**unavailable,'reason':'unreviewed_reference_inputs'}
    # Recheck the formula/growth/condition tables against the audited baseline.
    for name in profile['unchangedCoreTables']:
        if tables[name] != base['tables'][name]:
            return {**unavailable,'reason':'changed_reference_core','table':name}
    omit = {'client_version_download_url','client_version_recommended','client_version_required'}
    parameters = lambda rows: [r for r in rows if r['_id'] not in omit]
    if parameters(tables['Parameter']) != parameters(base['tables']['Parameter']):
        return {**unavailable,'reason':'changed_reference_parameters'}
    rules = deepcopy(base)
    rules.update(sourceReleaseId=release, verificationStatus='reference_compatible',masterSha256=hashes,tables=tables,
        packageVersion=profile['packageVersion'],ruleSetVersion=profile['id'],
        referenceProfile={'sourceReleaseId':base['sourceReleaseId'],'nativeSha256':base['nativeSha256'],
                          'dataCompatibility':'reviewed_current_tables','reviewId':profile['id'],
                          'currentGameplayVerified':False})
    rules['capabilities']['formationPower'] = 'reference_model_estimate'
    rules['capabilities']['event'] = 'requires_version_bound_adapter'
    return rules


EVENT_TABLES = ('LiveScoreRank', 'LiveChallengePoint', 'ChallengeMusic',
                'LiveMusicBoostBonus', 'ChallengeMusicBoostBonus', 'LiveEventPoint',
                'LiveEventReward', 'ChallengeLiveEventPoint', 'ChallengeLiveEventReward')


def bind_scoring_rules(master: Path, release: str, baseline=None):
    """Reuse the implemented model with current parameters, independently of releases.

    Master hashes identify inputs, not changes in native mechanics. Content
    derivatives report scoring coverage independently from publishing catalog
    data. The relevant calculator rejects unsupported candidate mechanisms.
    """
    base = baseline or json.loads(BASELINE.read_text())
    unavailable = {'schemaVersion': 1, 'sourceReleaseId': release,
                   'verificationStatus': 'unavailable'}
    if any(not (master/f'Master{name}.json').is_file() for name in TABLES):
        return {**unavailable, 'reason': 'missing_scoring_inputs'}
    try:
        tables, hashes = project_tables(master)
    except (ValueError, KeyError, TypeError):
        return {**unavailable, 'reason': 'invalid_scoring_inputs'}
    if release == base['sourceReleaseId']:
        if hashes != base['masterSha256']:
            return {**unavailable, 'reason': 'audit_input_mismatch'}
        return deepcopy(base)
    # Event inputs travel in the same immutable artifact as cards and songs.
    for name in EVENT_TABLES:
        path = master/f'Master{name}.json'
        if path.is_file():
            raw = path.read_bytes()
            rows = json.loads(raw)['_allData']
            if not isinstance(rows, list):
                return {**unavailable, 'reason':'invalid_event_inputs'}
            tables[name] = rows
            hashes[f'Master{name}'] = hashlib.sha256(raw).hexdigest()
    # The event threshold calculator needs the current song rank group too.
    music = {r['_id']: r for r in json.loads((master/'MasterLiveMusic.json').read_text())['_allData']}
    for song in tables['LiveMusic']:
        if '_liveScoreRankGroup' in music[song['_id']]:
            song['_liveScoreRankGroup'] = music[song['_id']]['_liveScoreRankGroup']
    rules = deepcopy(base)
    rules.update(sourceReleaseId=release, verificationStatus='reference_compatible',
                 tables=tables, masterSha256=hashes,
                 ruleSetVersion='ournotes-scoring-model-v1',
                 referenceProfile={'sourceReleaseId':base['sourceReleaseId'],
                     'nativeSha256':base['nativeSha256'], 'modelId':'ournotes-scoring-model-v1',
                     'dataCompatibility':'supported_model', 'currentGameplayVerified':False})
    rules['capabilities']['formationPower'] = 'reference_model_estimate'
    rules['capabilities']['event'] = 'requires_version_bound_adapter'
    return rules


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--master', type=Path, required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(bind_scoring_rules(args.master, args.release), ensure_ascii=False, separators=(',', ':')) + '\n')
