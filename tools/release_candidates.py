"""Build isolated core-data candidates; never activate or overwrite a website."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.build_site_catalog import BuildContext, build_catalog, write_release_projection
from tools.database_shards import write_database_shards
from tools.media_derivatives import generate_image_derivatives, build_media_index, validate_media_index
from tools.release_preflight import PreflightError, inspect_plan, load_plan, digest
from tools.site_product import prepare_public_data
from tools.score_inputs import read_score_inputs
from tools.music_audio_inputs import read_music_audio_inputs
from tools.story_text import read_story_inputs, project_library, story_fallback_locales
from tools.gallery import project_gallery
from tools.supplemental_inputs import read_supplemental
from tools.immutable_files import link_or_copy
from tools.bgm_catalog import project_bgm, read_bgm_inputs
from tools.scoring_content import bind_scoring_rules
from tools.formal_chart_projection import project_formal_charts
from tools.costume_catalog import project_costumes
from tools.costume_posters import poster_inputs


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def capture_gallery_inputs(master: Path, release: str, locale: str, source: Path, target: Path) -> Path:
    shutil.copytree(source, target)
    project_gallery(master, release, locale, target)
    return target


def compile_core(source: dict, destination: Path, locales: tuple[str, ...], root: Path) -> dict:
    """Use compiler APIs directly to avoid CLI defaults from other releases."""
    public = destination / 'public'
    generated = destination / 'generated'
    empty = destination / '.empty-inputs'
    empty.mkdir()
    results = []
    derivatives = None
    scores = read_score_inputs(source, root)
    audio_report = read_music_audio_inputs(source, root)
    bgm_inputs = read_bgm_inputs(source, root)
    story_inputs = read_story_inputs(source, root, lazy=True)
    supplemental = read_supplemental(source, root)
    if source['region'] == 'jp' and supplemental is None:
        raise PreflightError('JP requires its own supplemental inputs; Global fallbacks are forbidden')
    if supplemental:
        shutil.copytree(supplemental / 'data', destination / 'supplemental-data', ignore=shutil.ignore_patterns('.DS_Store'))
        for group in ('live2d', 'immersive', 'system-banners', 'mission-rewards', 'auto-stage', 'growth'):
            shutil.copytree(supplemental / 'public' / group, public / group, copy_function=link_or_copy, ignore=shutil.ignore_patterns('.DS_Store'))
    if supplemental and (supplemental / 'public/costumes').is_dir():
        shutil.copytree(supplemental / 'public/costumes', public / 'costumes', copy_function=link_or_copy)
    posters = poster_inputs(source, root)
    if posters:
        shutil.copytree(posters, public / 'costumes/posters', copy_function=link_or_copy)
    write_json(destination / 'supplemental-data/formal-scoring-rules.json',
               bind_scoring_rules(root / source['masterRoot'], source['contentReleaseId']))
    # Gallery is maintained separately. Freeze and validate it before lengthy
    # media work so concurrent refreshes cannot mix formats between locales.
    gallery_input = capture_gallery_inputs(root / source['masterRoot'], source['contentReleaseId'], locales[0],
                                           (supplemental / 'public/gallery') if supplemental else root / 'site/public/gallery', destination / '.gallery-inputs')
    try:
        for locale in locales:
            print(f"Compiling {source['region']} {source['contentReleaseId']} {locale}", file=sys.stderr, flush=True)
            context = BuildContext.from_manifest(root / source['manifest'], region=source['region'], locale=locale)
            build = build_catalog(
                root / source['assetManifest'], root / source['extractedRoot'],
                root / source['masterRoot'], empty, public / 'media',
                build_context=context, cri_report_path=empty / 'cri.json',
                music_audio_report_path=audio_report,
                live2d_runtime_report={}, adv_runtime_report={},
                published_music_data_root=None, include_music=scores is not None,
                bound_score_payloads=scores,
                supplemental_extracted_roots=(), functional_ui_extracted_roots=(),
            )
            project_formal_charts(build)
            # Local source paths belong in audit reports, not public catalogs.
            for asset in build.catalog.get('assets', []):
                asset['sourcePath'] = f"{asset.get('sourceBundle', 'bundle')}/{asset.get('sourceObjectId', 'object')}"
            for chart in build.catalog.get('musicCharts', []):
                chart['analysisDataUrl'] = f"/data/releases/{context.content_release_id}/{locale}/music-charts/{chart['id']}.json"
            write_release_projection(generated_root=generated, public_data_root=public / 'data', context=context, build=build)
            relative = Path('releases') / context.content_release_id / locale
            generated_data, public_data = generated / relative, public / 'data' / relative
            gallery = project_gallery(root / source['masterRoot'], context.content_release_id, locale, gallery_input)
            if gallery['comics'] and not (public / 'gallery').exists():
                shutil.copytree(gallery_input, public / 'gallery')
            story_library, story_documents = project_library(
                root / source['masterRoot'], context.content_release_id, locale, story_inputs,
                fallback_locale=story_fallback_locales(source['region'], locale))
            bgm = project_bgm(source, root, public, locale, inputs=bgm_inputs)
            live2d_path = destination / 'supplemental-data/live2d-catalog.json'
            costumes = project_costumes(root / source['masterRoot'], build.catalog,
                live2d=json.loads(live2d_path.read_text()) if live2d_path.is_file() else None,
                icons_root=public / 'costumes')
            for data_root in (generated_data, public_data):
                write_json(data_root / 'costumes.json', costumes)
                write_json(data_root / 'story-library.json', story_library)
                write_json(data_root / 'gallery.json', gallery)
                write_json(data_root / 'bgm.json', bgm)
                for story_id, document in story_documents.items():
                    write_json(data_root / 'story-text' / f'{story_id}.json', document)
            for chart_id, chart in build.artifacts.music_chart_data.items():
                for data_root in (generated_data, public_data):
                    write_json(data_root / 'music-charts' / f'{chart_id}.json', chart)
            write_database_shards(build.artifacts.game_database, build.artifacts.card_detail_projections,
                                  context.content_release_id, generated_data / 'database-shards',
                                  public_data / 'database-shards', destination / 'reports' / f'{locale}-shards.json')
            if derivatives is None:
                print(f"Generating image variants: {source['region']}", file=sys.stderr, flush=True)
                derivatives = generate_image_derivatives(build.catalog, public)
            index = build_media_index(build.catalog, {}, {}, {}, derivatives, {}, {})
            validate_media_index(index)
            for data_root in (generated_data, public_data):
                write_json(data_root / 'media-index.json', index)
                prepare_public_data(data_root)
            write_json(destination / 'reports' / f'{locale}-quality.json', build.quality_report)
            results.append({'locale': locale, 'assets': len(build.catalog.get('assets', [])),
                            'characters': len(build.catalog.get('characters', [])),
                            'musicTracks': len(build.catalog.get('musicTracks', [])),
                            'musicCharts': len(build.catalog.get('musicCharts', []))})
            # A second locale must not overlap the previous full compiler result.
            del build, story_documents, story_library, gallery, bgm, index
            import gc
            gc.collect()
    finally:
        shutil.rmtree(empty)
        shutil.rmtree(gallery_input)
    if supplemental:
        read_supplemental(source, root)
    # Originals may have been hard-linked by the compiler. Detach the candidate
    # so a later input edit cannot mutate its bytes (or vice versa).
    for path in (public / 'media').rglob('*'):
        if path.is_file() and path.stat().st_nlink > 1:
            replacement = path.with_name(path.name + '.detached')
            shutil.copy2(path, replacement)
            os.replace(replacement, path)
    return {'projections': results, 'limitations': ([] if scores is not None else ['music_and_score_inputs_not_bound']) + [
            'release_specific_overrides_not_bound', *(['runtime_and_stage_inputs_not_bound'] if not supplemental else []),
            'html_matrix_not_assembled'], 'publicationReady': False}


def build_candidates(plan: Path, output: Path, *, root: Path = ROOT,
                     locales: tuple[str, ...] = ('zh-CN', 'en'),
                     compiler=compile_core, keep_failed: bool = False) -> dict:
    if not locales or len(set(locales)) != len(locales) or any(locale not in {'zh-CN', 'en', 'ja', 'zh-TW'} for locale in locales):
        raise PreflightError('invalid or duplicate locales')
    if os.environ.get("OURNOTES_SITE_PROFILE", "v1") != "v1":
        raise PreflightError("isolated candidates require the v1 product profile")
    plan_digest = digest(plan)
    sources = load_plan(plan)
    expected_channel = 'production'
    if len(sources) != 1 or sources[0]['region'] not in {'global', 'jp'} or any(s['channel'] != expected_channel for s in sources):
        raise PreflightError('candidate requires one production edition with the selected source identity')
    readiness = inspect_plan(plan, root=root, require_production=True)
    if readiness['status'] != 'passed':
        raise PreflightError(f"candidate inputs: {readiness['status']}; run release_preflight for details")
    if output.is_symlink():
        raise PreflightError("candidate output must not be a symlink")
    bound_scores = {source['id']: read_score_inputs(source, root) for source in sources}
    bound_stories = {source['id']: read_story_inputs(source, root, lazy=True) for source in sources}
    output = output.resolve()
    # Candidates are new, private output directories, never source trees or a
    # previous build. The final rename is the only publication of this dataset.
    protected = [plan.resolve(), *(root / name for name in ('site', 'catalog', 'input', 'phone_dump', 'data', 'config'))]
    for source in sources:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', source['contentReleaseId']):
            raise PreflightError('unsafe release id')
        extracted = source.get('extractedRoot')
        if not isinstance(extracted, str) or not (root / extracted).is_dir():
            raise PreflightError(f"{source['id']}: explicit extractedRoot is required")
        if source.get('scoreInputs'):
            protected.append((root / source['scoreInputs']['index']).resolve().parent)
        if source.get('musicAudioInputs'):
            protected.append((root / source['musicAudioInputs']['report']).resolve().parent)
        if source.get('bgmAudioInputs'):
            protected.append((root / source['bgmAudioInputs']['report']).resolve().parent)
        protected.extend((root / source[key]).resolve() for key in ('manifest', 'masterRoot', 'assetManifest', 'extractedRoot'))
    if any(output == path or path in output.parents or output in path.parents for path in protected):
        raise PreflightError('candidate output overlaps protected input')
    if output.exists() or output.is_symlink():
        raise PreflightError('candidate output already exists; choose a new directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f'.{output.name}-', dir=output.parent))
    try:
        regions = []
        for source in sources:
            relative = Path(source['region']) / source['contentReleaseId']
            destination = temporary / relative
            destination.mkdir(parents=True)
            result = compiler(source, destination, locales, root)
            regions.append({'region': source['region'], 'channel': source['channel'],
                            'contentReleaseId': source['contentReleaseId'], 'path': relative.as_posix(), **result})
        # Fail if inputs changed during compilation, instead of blessing a mixed snapshot.
        if digest(plan) != plan_digest or inspect_plan(plan, root=root, require_production=True) != readiness:
            raise PreflightError('inputs changed during candidate generation')
        if any(read_score_inputs(source, root) != bound_scores[source['id']] for source in sources):
            raise PreflightError('score inputs changed during candidate generation')
        if any(read_story_inputs(source, root, lazy=True) != bound_stories[source['id']] for source in sources):
            raise PreflightError('story inputs changed during candidate generation')
        files = {path.relative_to(temporary).as_posix(): digest(path) for path in sorted(temporary.rglob('*')) if path.is_file() and path.name != '.DS_Store'}
        report = {'schemaVersion': 1, 'status': 'candidate_generated', 'historicalReplay': False,
                  'publicationReady': False, 'inputPlanSha256': plan_digest, 'regions': regions, 'files': files}
        write_json(temporary / 'candidate.json', report)
        if output.exists():
            raise PreflightError('candidate output appeared during generation')
        temporary.rename(output)
        return report
    except Exception as exc:
        if keep_failed and temporary.exists():
            (temporary / 'candidate.json').unlink(missing_ok=True)
            write_json(temporary / 'failed-candidate.json', {'status': 'failed', 'error': str(exc), 'publicationReady': False})
            retained = temporary.with_name(temporary.name + '.failed')
            temporary.rename(retained)
            print(f'Incomplete build retained at {retained}', file=sys.stderr, flush=True)
        raise
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=ROOT / 'config/release-inputs.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--locale', action='append')
    parser.add_argument('--keep-failed', action='store_true', help='retain private intermediate files after a failed build')
    parser.add_argument('--conversion-cache', type=Path, help='private reusable media cache restored with production state')
    args = parser.parse_args()
    if args.conversion_cache is not None:
        os.environ['OURNOTES_CONVERSION_CACHE'] = str(args.conversion_cache.resolve())
    try:
        result = build_candidates(args.plan, args.output,
                                  locales=tuple(args.locale or ['zh-CN', 'en']), keep_failed=args.keep_failed)
    except (PreflightError, OSError, ValueError) as exc:
        parser.exit(1, f'Candidate generation failed: {exc}\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'files'}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
