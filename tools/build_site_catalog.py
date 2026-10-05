#!/usr/bin/env python3
"""Build a deterministic static-site catalog from extracted Unity assets.

The extractor manifest is treated as generated evidence. This compiler only
creates relationships that can be proven from the manifest and keeps ambiguous
content in a pending state for optional JSON overrides.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path
from typing import Any, Iterable, Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from tools.master_catalog import (  # noqa: E402
    MasterCatalogError,
    build_master_entities,
    load_master_data,
)
from tools.game_database import (  # noqa: E402
    GameDatabaseError,
    build_game_database,
)
from tools.game_modes import (  # noqa: E402
    GameModeError,
    build_game_modes,
    empty_game_modes,
)
from tools.global_systems import (  # noqa: E402
    GlobalSystemsError,
    build_global_systems,
    empty_global_systems,
)
from tools.high_score_rating import (  # noqa: E402
    HighScoreRatingError,
    build_high_score_rating,
)
from tools.arena_rank import (  # noqa: E402
    ArenaRankError,
    build_arena_rank,
)
from tools.unified_search import (  # noqa: E402
    UnifiedSearchError,
    build_unified_search_index,
)
from tools.band_items import (  # noqa: E402
    BandItemBuild,
    BandItemError,
    build_band_items,
)
from tools.card_taxonomy import (  # noqa: E402
    FUNCTIONAL_ICON_ALIASES,
    CardTaxonomyError,
    build_band_logo_index,
    build_card_taxonomy,
)
from tools.music_catalog import (  # noqa: E402
    MusicCatalogError,
    build_music_catalog,
    collect_score_payloads,
)
from tools.music_audio import (  # noqa: E402
    MusicAudioBuild,
    MusicAudioError,
    build_music_audio,
    publish_music_audio,
)
from tools.story_pipeline import (  # noqa: E402
    StoryPipelineBuild,
    build_story_pipeline,
)
from tools.character_media import (  # noqa: E402
    CharacterMediaBuild,
    CharacterMediaError,
    build_character_media,
)
from tools.media_capabilities import (  # noqa: E402
    MediaCapabilityError,
    merge_media_capabilities,
)
from tools.resource_pipeline.localization import language_coverage  # noqa: E402
from tools.resource_pipeline.entity_projection import variant_ref  # noqa: E402
from tools.resource_pipeline.models import (  # noqa: E402
    Channel,
    EntityVariant,
    Region,
)
from tools.resource_classification import classify_resource  # noqa: E402
from tools.database_shards import (  # noqa: E402
    DatabaseShardError,
    write_database_shards,
)
from tools.artifact_registry import (  # noqa: E402
    ArtifactValidationError,
    validate_artifact,
)


DEFAULT_CRI_MEDIA_REPORT = REPO_ROOT / "input/global/optional/cri-media-report.json"
DEFAULT_PUBLISHED_MUSIC_DATA_ROOT = REPO_ROOT / "output/release-builds/global-production-current/site/global/zh-CN/data/music-charts"

CHARACTER_NAMES = {
    "character_thumbnail",
    "character_sprite",
    "character_face_icon",
    "board_icon",
}
CARD_NAMES = {
    "member_full",
    "member_thumbnail",
    "member_character",
    "member_background",
    "snap_full",
    "snap_thumbnail",
}
BACKGROUND_PATTERNS = (
    "adv_bkg",
    "background",
    "_bg",
    "bg_",
    "studio",
    "lobby",
    "cafe",
    "livehouse",
)
BANNER_PATTERNS = ("banner", "chapter", "story_top")
COVER_PATTERNS = ("jkt_", "jacket", "tentative_cover")
CARD_TAXONOMY_NAMES = {
    *FUNCTIONAL_ICON_ALIASES,
    *(f"sp_icon_live_music_type_{code}" for code in (1, 2, 3, 4, 5, 99)),
    "sp_card_rarity_star",
    "sp_cardrarityicon_r",
    "sp_cardrarityicon_sr",
    "sp_cardrarityicon_ssr",
    "sp_cardrarityicon_bd",
    "sp_cardrarityicon_ex",
    "icon_awakened",
    "awakening_base",
    "iconspecialtraining",
    "specialtraining",
    "memberexpicon",
    "snapexpicon",
}


class CatalogError(RuntimeError):
    """Raised when generated or override data violates publishing invariants."""


@dataclass(frozen=True)
class BuildContext:
    """The exact server release and locale selected for one projection."""

    content_release_id: str
    region: str
    channel: str
    locale: str
    release: dict[str, Any]

    @classmethod
    def from_manifest(
        cls,
        path: Path,
        *,
        region: str | None = None,
        locale: str = "zh-CN",
    ) -> "BuildContext":
        payload = load_json(path, {})
        content_release = payload.get("contentRelease")
        client_build = payload.get("clientBuild")
        if not isinstance(content_release, dict):
            identity = payload.get("identity")
            if isinstance(identity, dict):
                content_release = {
                    "id": identity.get("contentReleaseId"),
                    "region": identity.get("region"),
                    "channel": identity.get("channel"),
                }
                client_build = payload.get("client")
        if not isinstance(content_release, dict) or not isinstance(
            client_build, dict
        ):
            raise CatalogError(
                f"invalid ContentRelease manifest (missing identities): {path}"
            )
        manifest_region = str(content_release.get("region") or "")
        selected_region = region or manifest_region
        if selected_region not in {"global", "jp"}:
            raise CatalogError(f"unsupported region: {selected_region}")
        if selected_region != manifest_region:
            raise CatalogError(
                "requested region does not match ContentRelease manifest: "
                f"{selected_region} != {manifest_region}"
            )
        if locale not in {"zh-CN", "zh-TW", "ja", "en"}:
            raise CatalogError(f"unsupported locale: {locale}")
        release_id = str(content_release.get("id") or "")
        channel = str(content_release.get("channel") or "")
        if not release_id or channel not in {"staging", "production"}:
            raise CatalogError("ContentRelease identity is incomplete")
        version_name = str(client_build.get("versionName") or "")
        return cls(
            content_release_id=release_id,
            region=selected_region,
            channel=channel,
            locale=locale,
            release={
                "id": release_id,
                "region": selected_region,
                "channel": channel,
                "locale": locale,
                "packageName": str(client_build.get("packageName") or ""),
                "versionName": version_name,
                "versionCode": int(client_build.get("versionCode") or 0),
                "unityVersion": str(client_build.get("unityVersion") or ""),
                "label": f"{selected_region.upper()} {channel} {version_name}",
            },
        )


@dataclass(frozen=True)
class SiteProjectionArtifacts:
    """Typed outputs produced for one immutable site projection."""

    music_chart_data: dict[str, dict[str, Any]]
    game_database: dict[str, Any]
    game_modes: dict[str, Any]
    global_systems: dict[str, Any]
    high_score_rating: dict[str, Any]
    arena_rank: dict[str, Any]
    unified_search_index: dict[str, Any]
    card_detail_projections: dict[str, Any]
    band_item_database: dict[str, Any]
    band_item_quality_report: dict[str, Any] | None
    story_database: dict[str, Any] | None
    story_search_index: dict[str, Any] | None
    media_capabilities: dict[str, Any] | None
    story_quality_report: dict[str, Any] | None
    character_media_database: dict[str, Any] | None
    character_media_projections: dict[str, Any] | None
    character_media_search_index: dict[str, Any] | None
    character_media_quality_report: dict[str, Any] | None

    def release_files(
        self,
        catalog: dict[str, Any],
    ) -> dict[str, dict[str, Any] | None]:
        """Return the versioned JSON files published for a projection."""
        return {
            "catalog.json": catalog,
            "game-database.json": self.game_database,
            "game-modes.json": self.game_modes,
            "global-systems.json": self.global_systems,
            "high-score-rating.json": self.high_score_rating,
            "arena-rank.json": self.arena_rank,
            "unified-search-index.json": self.unified_search_index,
            "card-detail-projections.json": self.card_detail_projections,
            "band-items.json": self.band_item_database,
            "story-database.json": self.story_database,
            "story-search-index.json": self.story_search_index,
            "media-capabilities.json": self.media_capabilities,
            "character-media.json": self.character_media_database,
            "character-media-projections.json": (
                self.character_media_projections
            ),
            "character-media-search-index.json": (
                self.character_media_search_index
            ),
        }


@dataclass(frozen=True)
class SiteProjectionPublications:
    """Media publications emitted after the JSON projection is accepted."""

    character_audio: list[dict[str, Any]]
    character_textures: list[dict[str, Any]]


@dataclass(frozen=True)
class SiteProjectionBuild:
    """One catalog compiler result with an explicit maintenance interface."""

    catalog: dict[str, Any]
    artifacts: SiteProjectionArtifacts
    publications: SiteProjectionPublications
    quality_report: dict[str, Any]


def compact_hash(value: str, length: int = 10) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]


def stable_id(prefix: str, record: dict[str, Any]) -> str:
    source = f"{record.get('bundle', '')}:{record.get('path_id', '')}"
    return f"{prefix}-{compact_hash(source)}"


def classify_kind(name: str, container_path: str = "") -> str:
    lower = name.lower()
    if re.fullmatch(
        r"Assets/AddressableResources/Band/\d+/band_logo(?:_white)?\.png",
        container_path,
        re.IGNORECASE,
    ):
        return "band_logo"
    if lower in CARD_TAXONOMY_NAMES:
        return "card_taxonomy"
    if re.fullmatch(
        r"Assets/AddressableResources/Band/\d+/BandItem/\d+/band_item\.png",
        container_path,
    ):
        return "band_item"
    if re.fullmatch(
        r"Assets/AddressableResources/Stamp/illust/[^/]+\.png",
        container_path,
    ):
        return "stamp"
    if re.fullmatch(
        r"Assets/AddressableResources/Item/[^/]+/item_icon[^/]*\.png",
        container_path,
    ):
        return "item"
    if re.fullmatch(
        r"Assets/AddressableResources/Character/Skill/[^/]+\.png",
        container_path,
    ):
        return "skill"
    if lower in CHARACTER_NAMES:
        return "character"
    if lower in CARD_NAMES:
        return "card"
    if any(pattern in lower for pattern in COVER_PATTERNS):
        return "cover"
    if any(pattern in lower for pattern in BANNER_PATTERNS):
        return "banner"
    if any(pattern in lower for pattern in BACKGROUND_PATTERNS):
        return "background"
    if "logo" in lower:
        return "logo"
    return "other"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def texture_records(
    manifest: dict[str, Any], extracted_root: Path
) -> list[dict[str, Any]]:
    records = []
    for raw in manifest.get("assets", []):
        is_functional_sprite = raw.get("type") == "Sprite" and classify_kind(
            str(raw.get("name", "")), str(raw.get("container_path", ""))
        ) == "card_taxonomy"
        if (raw.get("type") != "Texture2D" and not is_functional_sprite) or not raw.get("exported_file"):
            continue
        source = extracted_root / str(raw["exported_file"])
        if not source.is_file():
            continue
        record = dict(raw)
        record["source_file"] = source
        record["kind"] = classify_kind(
            str(raw.get("name", "")),
            str(raw.get("container_path", "")),
        )
        records.append(record)
    return sorted(
        records,
        key=lambda item: (
            str(item.get("bundle", "")),
            str(item.get("name", "")),
            int(item.get("path_id", 0)),
        ),
    )


def functional_ui_records(
    manifest: dict[str, Any], extracted_root: Path
) -> list[dict[str, Any]]:
    """Load only verified functional sprites from a broad UI extraction."""

    records = []
    for raw in manifest.get("assets", []):
        if raw.get("type") not in {"Texture2D", "Sprite"}:
            continue
        if not raw.get("exported_file"):
            continue
        kind = classify_kind(
            str(raw.get("name", "")),
            str(raw.get("container_path", "")),
        )
        if kind != "card_taxonomy":
            continue
        source = extracted_root / str(raw["exported_file"])
        if not source.is_file():
            continue
        record = dict(raw)
        record["source_file"] = source
        record["kind"] = kind
        records.append(record)
    return sorted(
        records,
        key=lambda item: (
            str(item.get("name", "")),
            str(item.get("bundle", "")),
            int(item.get("path_id", 0)),
        ),
    )


def select_catalog_records(
    records: list[dict[str, Any]], extra_limit: int = 48
) -> list[dict[str, Any]]:
    """Select a useful but bounded first-release public asset set."""
    primary = [
        record
        for record in records
        if str(record.get("name", "")).lower()
        in {
            "character_thumbnail",
            "character_sprite",
            "character_face_icon",
            "member_full",
            "snap_full",
        }
    ]
    extras = [
        record
        for record in records
        if record["kind"] in {"background", "banner", "cover", "logo"}
    ][:extra_limit]
    music_jackets = [
        record
        for record in records
        if re.fullmatch(
            r"Assets/AddressableResources/Image/Jacket/[^/]+\.png",
            str(record.get("container_path", "")),
        )
    ]
    database_icons = [
        record
        for record in records
        if record["kind"] in {"item", "skill"}
    ]
    card_taxonomy_assets = [
        record
        for record in records
        if record["kind"] in {"card_taxonomy", "band_logo"}
    ]
    character_media_images = [
        record
        for record in records
        if re.fullmatch(
            r"Assets/AddressableResources/Image/Comic/[^/]+\.png",
            str(record.get("container_path", "")),
        )
        or re.fullmatch(
            r"Assets/AddressableResources/Story/(?:Banner|Image)/.+\.png",
            str(record.get("container_path", "")),
        )
    ]
    event_images = [
        record for record in records
        if re.fullmatch(r"Assets/AddressableResources/Image/Event/[^/]+/(?:Logo|Top)/[^/]+\.png",
                        str(record.get("container_path", "")))
    ]
    band_item_and_stamp_images = [
        record
        for record in records
        if record["kind"] in {"band_item", "stamp"}
    ]

    selected: dict[str, dict[str, Any]] = {}
    for record in [
        *primary,
        *extras,
        *music_jackets,
        *database_icons,
        *card_taxonomy_assets,
        *character_media_images,
        *band_item_and_stamp_images,
        *event_images,
    ]:
        selected[str(record["source_file"])] = record
    return list(selected.values())


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def display_source_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def find_executable(explicit: Path | None, candidates: Iterable[str]) -> Path:
    if explicit is not None:
        if explicit.is_file():
            return explicit
        raise FileNotFoundError(explicit)
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return Path(resolved)
        path = Path(candidate)
        if path.is_file():
            return path
    raise FileNotFoundError(f"executable not found: {', '.join(candidates)}")


def load_pillow() -> Any:
    try:
        from PIL import Image  # type: ignore
    except ModuleNotFoundError:
        dependency_dir = REPO_ROOT / "analysis/.deps"
        if dependency_dir.is_dir():
            sys.path.insert(0, str(dependency_dir))
        from PIL import Image  # type: ignore
    return Image


def write_media(
    record: dict[str, Any],
    asset_id: str,
    media_root: Path,
    skip_media: bool,
) -> tuple[str, str, str]:
    preview_url = f"/media/previews/{asset_id}.webp"
    thumbnail_url = f"/media/thumbnails/{asset_id}.webp"
    original_url = f"/media/originals/{asset_id}.png"
    if skip_media:
        return preview_url, thumbnail_url, original_url

    preview_path = media_root / "previews" / f"{asset_id}.webp"
    thumbnail_path = media_root / "thumbnails" / f"{asset_id}.webp"
    original_path = media_root / "originals" / f"{asset_id}.png"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
    original_path.parent.mkdir(parents=True, exist_ok=True)

    source = Path(record["source_file"])
    source_sha = file_sha256(source)
    load_pillow()
    from tools.conversion_cache import restore as cache_restore, save as cache_save, image_recipe
    preview_recipe = image_recipe('preview-webp-1200-q84-m6-v1')
    thumbnail_recipe = image_recipe('thumbnail-webp-320-q72-m6-v1')
    if not original_path.exists() or file_sha256(original_path) != source_sha:
        if original_path.exists():
            original_path.unlink()
        try:
            os.link(source, original_path)
        except OSError:
            shutil.copy2(source, original_path)

    preview_cached = cache_restore(source_sha, preview_recipe, preview_path)
    if not preview_cached:
        Image = load_pillow()
        with Image.open(source) as image:
            image.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA")
            image.save(preview_path, "WEBP", quality=84, method=6)
    cache_save(source_sha, preview_recipe, preview_path)

    Image = load_pillow()
    thumbnail_cached = cache_restore(source_sha, thumbnail_recipe, thumbnail_path)
    thumbnail_is_stale = not thumbnail_cached
    if not thumbnail_is_stale:
        with Image.open(thumbnail_path) as existing_thumbnail:
            thumbnail_is_stale = max(existing_thumbnail.size) > 320
    if thumbnail_is_stale:
        with Image.open(source) as image:
            image.thumbnail((320, 320), Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA")
            image.save(thumbnail_path, "WEBP", quality=72, method=6)
    cache_save(source_sha, thumbnail_recipe, thumbnail_path)

    return preview_url, thumbnail_url, original_url


def asset_from_record(
    record: dict[str, Any],
    media_root: Path,
    skip_media: bool,
    release_id: str,
) -> dict[str, Any]:
    asset_id = stable_id("asset", record)
    source = Path(record["source_file"])
    classification = classify_resource(
        str(record["kind"]), str(record.get("container_path", ""))
    )
    preview_url, thumbnail_url, original_url = write_media(
        record, asset_id, media_root, skip_media
    )
    return {
        "id": asset_id,
        "displayName": str(record.get("name") or "未命名资源"),
        "kind": record["kind"],
        "objectType": record.get("type", "Texture2D"),
        "width": int(record.get("width") or 0),
        "height": int(record.get("height") or 0),
        "byteSize": source.stat().st_size,
        "sha256": file_sha256(source),
        "sourcePath": display_source_path(source),
        "sourceBundle": str(record.get("bundle", "")),
        "sourceObjectId": str(record.get("path_id", "")),
        "containerPath": str(record.get("container_path", "")),
        "sourceReleaseId": release_id,
        **classification,
        "downloadPolicy": (
            "preview_only"
            if record["kind"] in {"item", "skill", "band_item", "stamp"}
            else "preview_and_download"
        ),
        "previewUrl": preview_url,
        "thumbnailUrl": thumbnail_url,
        "originalUrl": original_url,
    }


def apply_entity_overrides(
    entities: list[dict[str, Any]],
    overrides: dict[str, Any],
    label: str,
    protected_fields: Iterable[str] = (),
) -> list[dict[str, Any]]:
    by_id = {entity["id"]: dict(entity) for entity in entities}
    protected = set(protected_fields)
    for entity_id, fields in overrides.items():
        if entity_id not in by_id:
            raise CatalogError(
                f"{label} override references unknown id: {entity_id}"
            )
        if not isinstance(fields, dict):
            raise CatalogError(f"{label} override must be an object: {entity_id}")
        forbidden = protected.intersection(fields)
        if forbidden:
            raise CatalogError(
                f"{label} override cannot replace verified fields for "
                f"{entity_id}: {', '.join(sorted(forbidden))}"
            )
        by_id[entity_id].update(fields)
    return [by_id[entity["id"]] for entity in entities]


def validate_catalog(catalog: dict[str, Any]) -> list[str]:
    errors = []
    assets = catalog.get("assets", [])
    bands = catalog.get("bands", [])
    characters = catalog.get("characters", [])
    member_cards = catalog.get("memberCards", [])
    support_cards = catalog.get("supportCards", [])
    music_tracks = catalog.get("musicTracks", [])
    music_charts = catalog.get("musicCharts", [])

    for label, entries in (
        ("asset", assets),
        ("band", bands),
        ("character", characters),
        ("member card", member_cards),
        ("support card", support_cards),
        ("music track", music_tracks),
        ("music chart", music_charts),
    ):
        ids = [entry.get("id") for entry in entries]
        if len(ids) != len(set(ids)):
            errors.append(f"duplicate {label} id")

    asset_ids = {asset["id"] for asset in assets}
    band_ids = {band["id"] for band in bands}
    character_ids = {character["id"] for character in characters}
    member_card_ids = {card["id"] for card in member_cards}
    support_card_ids = {card["id"] for card in support_cards}
    music_track_ids = {track["id"] for track in music_tracks}
    music_chart_ids = {chart["id"] for chart in music_charts}
    for band in bands:
        missing_characters = set(band.get("characterIds", [])) - character_ids
        if missing_characters:
            errors.append(
                f"{band['id']} has missing characters "
                f"{sorted(missing_characters)}"
            )
    for character in characters:
        profile_asset_id = character.get("profileAssetId")
        if profile_asset_id and profile_asset_id not in asset_ids:
            errors.append(
                f"{character['id']} has missing profile asset "
                f"{profile_asset_id}"
            )
        if character.get("bandId") not in band_ids:
            errors.append(
                f"{character['id']} has missing band "
                f"{character.get('bandId')}"
            )
        missing_members = (
            set(character.get("memberCardIds", [])) - member_card_ids
        )
        if missing_members:
            errors.append(
                f"{character['id']} has missing member cards "
                f"{sorted(missing_members)}"
            )
        missing_supports = (
            set(character.get("featuredSupportCardIds", []))
            - support_card_ids
        )
        if missing_supports:
            errors.append(
                f"{character['id']} has missing support cards "
                f"{sorted(missing_supports)}"
            )
    for card in member_cards:
        primary_asset_id = card.get("primaryAssetId")
        if primary_asset_id and primary_asset_id not in asset_ids:
            errors.append(
                f"{card['id']} has missing primary asset "
                f"{primary_asset_id}"
            )
        if card.get("characterId") not in character_ids:
            errors.append(
                f"{card['id']} has missing character {card['characterId']}"
            )
    for card in support_cards:
        primary_asset_id = card.get("primaryAssetId")
        if primary_asset_id and primary_asset_id not in asset_ids:
            errors.append(
                f"{card['id']} has missing primary asset "
                f"{primary_asset_id}"
            )
        missing_characters = (
            set(card.get("featuredCharacterIds", [])) - character_ids
        )
        if missing_characters:
            errors.append(
                f"{card['id']} has missing featured characters "
                f"{sorted(missing_characters)}"
            )
    for track in music_tracks:
        jacket_asset_id = track.get("jacketAssetId")
        if jacket_asset_id and jacket_asset_id not in asset_ids:
            errors.append(
                f"{track['id']} has missing jacket asset {jacket_asset_id}"
            )
        missing_charts = set(track.get("chartIds", [])) - music_chart_ids
        if missing_charts:
            errors.append(
                f"{track['id']} has missing charts {sorted(missing_charts)}"
            )
        if len(track.get("chartIds", [])) != 4:
            errors.append(f"{track['id']} must have four difficulty charts")
    for chart in music_charts:
        if chart.get("trackId") not in music_track_ids:
            errors.append(
                f"{chart['id']} has missing track {chart.get('trackId')}"
            )
    return errors


def validate_game_database_links(
    catalog: dict[str, Any],
    card_projections: dict[str, Any],
) -> list[str]:
    errors = []
    expected_members = {card["id"] for card in catalog.get("memberCards", [])}
    expected_supports = {
        card["id"] for card in catalog.get("supportCards", [])
    }
    projected_members = {
        projection.get("cardId")
        for projection in card_projections.get("memberCards", [])
    }
    projected_supports = {
        projection.get("cardId")
        for projection in card_projections.get("supportCards", [])
    }
    if projected_members != expected_members:
        errors.append(
            "member card projections do not match catalog cards: "
            f"missing={sorted(expected_members - projected_members)}, "
            f"extra={sorted(projected_members - expected_members)}"
        )
    if projected_supports != expected_supports:
        errors.append(
            "support card projections do not match catalog cards: "
            f"missing={sorted(expected_supports - projected_supports)}, "
            f"extra={sorted(projected_supports - expected_supports)}"
        )
    return errors


def catalog_publication_policy(
    music_tracks: list[dict[str, Any]],
    *,
    music_audio_playback: bool = False,
) -> dict[str, Any]:
    audio_setting = os.environ.get(
        "OURNOTES_ENABLE_CHARACTER_AUDIO",
        "1",
    ).strip().lower()
    character_audio = audio_setting not in {"0", "false", "no", "off"}
    music_setting = os.environ.get(
        "OURNOTES_ENABLE_MUSIC_AUDIO",
        "1",
    ).strip().lower()
    music_audio = music_setting not in {"0", "false", "no", "off"}
    return {
        "music": {
            "enabled": bool(music_tracks),
            "audioPlayback": music_audio and music_audio_playback,
            "audioDownload": music_audio and music_audio_playback,
            "scoreExport": False,
        },
        "stories": {
            "enabled": True,
            "disabledRoles": {},
        },
        "characterMedia": {
            "enabled": True,
            "audioPlayback": character_audio,
            "audioDownload": False,
            "live2dPlayback": False,
        },
    }


def build_entity_variants(
    context: BuildContext,
    entity_groups: Iterable[tuple[str, list[dict[str, Any]], str]],
) -> list[dict[str, Any]]:
    """Attach every public business entity to one exact server release."""
    variants: list[dict[str, Any]] = []
    for entity_type, entities, display_field in entity_groups:
        for entity in entities:
            localized = entity.get("localizedText")
            if not isinstance(localized, dict) or not localized:
                display = str(entity.get(display_field) or entity.get("id") or "")
                localized = {context.locale: display}
            asset_relations = sorted(
                {
                    value
                    for key in (
                        "profileAssetId",
                        "primaryAssetId",
                        "jacketAssetId",
                    )
                    if isinstance((value := entity.get(key)), str) and value
                }
            )
            variant = EntityVariant(
                entity_type=entity_type,
                region=Region(context.region),
                channel=Channel(context.channel),
                source_master_id=str(entity.get("masterId") or entity["id"]),
                first_seen_content_release=context.content_release_id,
                last_seen_content_release=context.content_release_id,
                availability="available",
                localized_text=tuple(sorted(localized.items())),
                asset_relations=tuple(asset_relations),
                source_evidence=(f"master:{entity.get('masterId')}",),
            )
            variants.append(
                {
                    "variantRef": variant_ref(variant),
                    "entityType": variant.entity_type,
                    "region": variant.region.value,
                    "channel": variant.channel.value,
                    "sourceMasterId": variant.source_master_id,
                    "firstSeenContentRelease": variant.first_seen_content_release,
                    "lastSeenContentRelease": variant.last_seen_content_release,
                    "availability": variant.availability,
                    "localizedText": variant.localized_text_dict(),
                    "assetRelations": list(variant.asset_relations),
                    "sourceEvidence": list(variant.source_evidence),
                }
            )
    return sorted(variants, key=lambda item: item["variantRef"])


def _combo_event_signature(event: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if event is None:
        return None
    return {
        "time": event.get("time"),
        "markerId": event.get("markerId"),
        "noteId": event.get("noteId"),
        "nodeIndex": event.get("nodeIndex"),
        "synthetic": event.get("synthetic") is True,
    }


def compare_published_music_timelines(
    report: dict[str, Any],
    current_chart_data: Mapping[str, Mapping[str, Any]],
    published_music_data_root: Path | None,
) -> None:
    """Attach a non-authoritative shadow comparison to the build report."""

    rows = report.get("musicScoreRuntimeReport", [])
    if not isinstance(rows, list):
        return
    for row in rows:
        chart_id = str(row["chartId"])
        current = current_chart_data.get(chart_id, {})
        published_path = (
            published_music_data_root / f"{chart_id}.json"
            if published_music_data_root is not None
            else None
        )
        if published_path is None or not published_path.is_file():
            row["shadowComparisonStatus"] = "unavailable"
            row["requiresManualReview"] = (
                row["classification"] != "MATCH"
            )
            continue
        try:
            published = json.loads(published_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            row["shadowComparisonStatus"] = "invalid-published-projection"
            row["requiresManualReview"] = True
            continue

        old_events = published.get("comboEvents", [])
        new_events = current.get("comboEvents", [])
        if not isinstance(old_events, list) or not isinstance(new_events, list):
            row["shadowComparisonStatus"] = "invalid-published-timeline"
            row["requiresManualReview"] = True
            continue

        row["shadowComparisonStatus"] = "compared"
        old_statistics = published.get("statistics", {})
        if isinstance(old_statistics, dict):
            row["oldPublishedFullCombo"] = int(
                old_statistics.get("judgementCount", len(old_events))
            )
        else:
            row["oldPublishedFullCombo"] = len(old_events)

        first_difference = None
        for index, (old_event, new_event) in enumerate(
            zip_longest(old_events, new_events)
        ):
            old_signature = _combo_event_signature(old_event)
            new_signature = _combo_event_signature(new_event)
            if old_signature != new_signature:
                first_difference = {
                    "combo": index + 1,
                    "published": old_signature,
                    "runtime": new_signature,
                }
                break
        row["firstTimelineDifference"] = first_difference
        if row["classification"] == "MATCH" and first_difference is not None:
            row["classification"] = "TIMELINE_CHANGED_ONLY"
        row["requiresManualReview"] = row["classification"] != "MATCH"

    classifications = (
        "MATCH",
        "RUNTIME_HIGHER",
        "RUNTIME_LOWER",
        "TIMELINE_CHANGED_ONLY",
        "COMPILE_ERROR",
    )
    report["musicScoreRuntimeClassificationCounts"] = {
        classification: sum(
            row.get("classification") == classification for row in rows
        )
        for classification in classifications
    }


def build_catalog(
    manifest_path: Path,
    extracted_root: Path,
    master_root: Path,
    overrides_root: Path,
    media_root: Path,
    skip_media: bool = False,
    extra_limit: int = 48,
    assets_only: bool = False,
    cri_report_path: Path = DEFAULT_CRI_MEDIA_REPORT,
    music_audio_report_path: Path | None = None,
    ffmpeg_path: Path | None = None,
    ffprobe_path: Path | None = None,
    build_context: BuildContext | None = None,
    supplemental_extracted_roots: Iterable[Path] = (),
    functional_ui_extracted_roots: Iterable[Path] = (),
    live2d_runtime_report: Mapping[str, Any] | None = None,
    adv_runtime_report: Mapping[str, Any] | None = None,
    published_music_data_root: Path | None = None,
    include_music: bool = True,
    bound_score_payloads: Mapping[str, bytes] | None = None,
) -> SiteProjectionBuild:
    if build_context is None:
        raise CatalogError(
            "build_catalog requires a ContentRelease BuildContext"
        )
    release_id = build_context.content_release_id
    manifest = load_json(manifest_path, {})
    all_records = texture_records(manifest, extracted_root)
    for supplemental_root in supplemental_extracted_roots:
        supplemental_manifest = supplemental_root / "manifest.json"
        if not supplemental_manifest.is_file():
            continue
        all_records.extend(
            texture_records(
                load_json(supplemental_manifest, {}),
                supplemental_root,
            )
        )
    for functional_root in functional_ui_extracted_roots:
        functional_manifest = functional_root / "manifest.json"
        if not functional_manifest.is_file():
            continue
        all_records.extend(
            functional_ui_records(
                load_json(functional_manifest, {}),
                functional_root,
            )
        )
    selected_records = select_catalog_records(all_records, extra_limit)
    from tools.media_parallel import map_images
    assets = map_images(
        lambda record: asset_from_record(record, media_root, skip_media, release_id),
        selected_records,
    )
    asset_ids = {
        str(record["source_file"]): stable_id("asset", record)
        for record in selected_records
    }
    card_taxonomy = {
        "attributes": [],
        "rarities": [],
        "growthIcons": {},
    }
    if assets_only:
        entities = {
            "bands": [],
            "characters": [],
            "memberCards": [],
            "supportCards": [],
        }
        asset_labels: dict[str, str] = {}
        music_tracks: list[dict[str, Any]] = []
        music_charts: list[dict[str, Any]] = []
        music_chart_data: dict[str, dict[str, Any]] = {}
        music_warnings: list[str] = []
        game_database = {
            "schemaVersion": 1,
            "sourceReleaseId": release_id,
            "skills": [],
            "conditions": [],
            "conditionGroups": [],
            "cumulativeConditions": [],
            "targets": [],
            "growthProfiles": [],
            "skillLevelResourceProfiles": [],
            "items": [],
            "quality": {},
        }
        game_modes = empty_game_modes(
            release_id,
            "unavailable_in_assets_only_build",
        )
        global_systems = empty_global_systems(release_id)
        high_score_rating = {
            "schemaVersion": 1,
            "sourceReleaseId": release_id,
            "status": "unavailable_in_assets_only_build",
            "topMusicCount": 0,
            "scopes": {"total": {"levels": []}, "band": {"levels": []}},
        }
        arena_rank = {
            "schemaVersion": 1,
            "sourceReleaseId": release_id,
            "status": "unavailable_in_assets_only_build",
            "capabilities": [],
            "relationships": [],
            "currentSeason": None,
            "pastSeasons": [],
            "missingServerFields": [],
        }
        card_projections = {
            "schemaVersion": 1,
            "memberCards": [],
            "supportCards": [],
        }
        band_item_build: BandItemBuild | None = None
        band_item_database = {
            "schemaVersion": 1,
            "sourceReleaseId": release_id,
            "bands": [],
            "items": [],
            "quality": {},
        }
        band_item_warnings: list[str] = []
        game_warnings: list[str] = []
        story_pipeline: StoryPipelineBuild | None = None
        character_media: CharacterMediaBuild | None = None
        merged_media_capabilities: dict[str, Any] | None = None
        publication_policy = catalog_publication_policy([])
        music_audio_records: list[Any] = []
        music_audio_warnings: list[str] = []
        music_audio_rejected: list[dict[str, Any]] = []
        music_audio_playback = False
    else:
        master = load_master_data(master_root)
        taxonomy_records = [
            record
            for record in selected_records
            if record.get("kind") == "card_taxonomy"
        ]
        if taxonomy_records:
            card_taxonomy = build_card_taxonomy(
                taxonomy_records,
                asset_ids,
            )
        entities, asset_labels = build_master_entities(
            master,
            selected_records,
            asset_ids,
            release_id,
            build_context.locale,
        )
        band_logo_index = build_band_logo_index(
            selected_records,
            asset_ids,
        )
        if band_logo_index:
            for band in entities["bands"]:
                logos = band_logo_index.get(int(band["masterId"]))
                if (
                    logos is None
                    or "logoAssetId" not in logos
                    or "whiteLogoAssetId" not in logos
                ):
                    raise CardTaxonomyError(
                        f"missing logo pair for band {band['masterId']}"
                    )
                band.update(logos)
        icon_asset_ids: dict[str, str] = {}
        for record in selected_records:
            kind = record.get("kind")
            if kind not in {"item", "skill"}:
                continue
            asset_id = asset_ids[str(record["source_file"])]
            name = str(record.get("name", ""))
            if name:
                icon_asset_ids[name] = asset_id
            container_path = str(record.get("container_path", ""))
            prefix = "Assets/AddressableResources/"
            if container_path.startswith(prefix) and container_path.endswith(
                ".png"
            ):
                icon_asset_ids[
                    container_path[len(prefix) : -len(".png")]
                ] = asset_id
        game_build = build_game_database(
            master_root,
            release_id,
            icon_asset_ids,
        )
        game_database = game_build.database
        global_systems = (
            build_global_systems(master_root, release_id, build_context.locale)
            if build_context.region in {"global", "jp"}
            and build_context.channel == "production"
            else empty_global_systems(release_id)
        )
        card_projections = game_build.card_projections
        game_warnings = game_build.warnings
        if (master_root / "MasterLiveFreeReward.json").is_file():
            game_modes = build_game_modes(master_root, release_id, edition=build_context.region, locale=build_context.locale)
        else:
            game_modes = empty_game_modes(
                release_id,
                "unavailable_in_reduced_master_build",
            )
            game_warnings.append(
                "game mode tables unavailable in reduced Master build"
            )
        if (master_root / "MasterLiveTotalHighScoreRating.json").is_file():
            high_score_rating = build_high_score_rating(master_root, release_id)
        else:
            high_score_rating = {
                "schemaVersion": 1,
                "sourceReleaseId": release_id,
                "status": "unavailable_in_reduced_master_build",
                "topMusicCount": 0,
                "scopes": {"total": {"levels": []}, "band": {"levels": []}},
            }
            game_warnings.append(
                "High Score Rating tables unavailable in reduced Master build"
            )
        if (master_root / "MasterLiveGekisouMatchingBucket.json").is_file():
            arena_rank = build_arena_rank(
                master_root,
                release_id,
                REPO_ROOT / "catalog/evidence/arena-client.json",
            )
        else:
            arena_rank = {
                "schemaVersion": 1,
                "sourceReleaseId": release_id,
                "status": "unavailable_in_reduced_master_build",
                "capabilities": [],
                "relationships": [],
                "currentSeason": None,
                "pastSeasons": [],
                "missingServerFields": [],
            }
            game_warnings.append(
                "Arena evidence unavailable in reduced Master build"
            )
        band_item_build = build_band_items(
            master_root,
            release_id,
            assets,
        )
        band_item_database = band_item_build.database
        band_item_warnings = band_item_build.warnings
        if include_music and (master_root / "MasterLiveMusic.json").is_file():
            if bound_score_payloads is not None:
                score_payloads = dict(bound_score_payloads)
            else:
                bundle_root = Path(str(manifest.get("bundle_directory", "")))
                if not bundle_root.is_absolute():
                    bundle_root = REPO_ROOT / bundle_root
                score_payloads = collect_score_payloads(
                    manifest, extracted_root, bundle_root,
                )
            jacket_asset_ids = {
                str(record.get("name", "")): asset_ids[str(record["source_file"])]
                for record in selected_records
                if re.fullmatch(
                    r"Assets/AddressableResources/Image/Jacket/[^/]+\.png",
                    str(record.get("container_path", "")),
                )
            }
            music = build_music_catalog(
                master_root,
                score_payloads,
                jacket_asset_ids,
                release_id,
            )
            music_tracks = music.tracks
            music_charts = music.charts
            music_chart_data = music.chart_data
            music_warnings = music.warnings
            music_titles_by_asset = {
                track["jacketAssetId"]: f"{track['title']} · 曲目封面"
                for track in music_tracks
                if track.get("jacketAssetId")
            }
            asset_labels.update(music_titles_by_asset)
        else:
            music_tracks = []
            music_charts = []
            music_chart_data = {}
            music_warnings = (
                []
                if include_music
                else ["music projection omitted: offline package has no extracted score payloads"]
            )

        music_audio: MusicAudioBuild | None = None
        music_audio_records = []
        music_audio_warnings: list[str] = []
        music_audio_rejected: list[dict[str, Any]] = []
        music_audio_playback = False
        if music_tracks and (master_root / "MasterSound.json").is_file() and (
            master_root / "MasterSoundCueSheet.json"
        ).is_file():
            audio_report = (
                music_audio_report_path
            )
            if audio_report is not None and audio_report.is_file():
                try:
                    music_audio = build_music_audio(master_root, audio_report, repo_root=REPO_ROOT)
                except MusicAudioError as exc:
                    raise CatalogError(
                        f"music audio adapter failed: {exc}"
                    ) from exc
                music_audio_rejected = list(music_audio.rejected)
                music_audio_warnings = list(music_audio.warnings)
                if not skip_media and music_audio.publish_records:
                    resolved_ffmpeg = ffmpeg_path or find_executable(
                        None, ("ffmpeg", "/opt/homebrew/opt/ffmpeg/bin/ffmpeg")
                    )
                    resolved_ffprobe = ffprobe_path or find_executable(
                        None, ("ffprobe", "/opt/homebrew/opt/ffmpeg/bin/ffprobe")
                    )
                    try:
                        music_audio_records = publish_music_audio(
                            music_audio,
                            media_root.parent,
                            ffmpeg=resolved_ffmpeg,
                            ffprobe=resolved_ffprobe,
                            skip_media=skip_media,
                        )
                    except MusicAudioError as exc:
                        raise CatalogError(
                            f"music audio publish failed: {exc}"
                        ) from exc
                    # Rebuild overlays with the content-hash-bearing URLs from
                    # the published records.
                    for published_record in music_audio_records:
                        overlay = music_audio.overlays.get(published_record.track_id)
                        if overlay is not None:
                            overlay["audioUrl"] = published_record.target_url
                for track in music_tracks:
                    overlay = music_audio.overlays.get(track["id"])
                    if overlay is None:
                        track["audioStatus"] = "missing"
                        track["audioPlayback"] = False
                        track["audioDownload"] = False
                        track["audioUrl"] = None
                        track["audioDuration"] = None
                        track["audioCodec"] = None
                        continue
                    track["audioUrl"] = overlay["audioUrl"]
                    track["audioDuration"] = overlay["audioDuration"]
                    track["audioCodec"] = overlay["audioCodec"]
                    track["audioStatus"] = overlay["audioStatus"]
                    track["audioPlayback"] = overlay["audioPlayback"]
                    track["audioDownload"] = overlay["audioDownload"]
                music_audio_playback = any(
                    track.get("audioPlayback") for track in music_tracks
                )

        publication_policy = catalog_publication_policy(
            music_tracks, music_audio_playback=music_audio_playback
        )
        story_pipeline = build_story_pipeline(
            master_root,
            master,
            manifest_path,
            extracted_root,
            release_id=release_id,
            publication_policy=publication_policy,
            adv_runtime_report=adv_runtime_report,
        )
        character_media = build_character_media(
            master_root,
            master,
            manifest_path,
            cri_report_path,
            assets,
            story_pipeline.database,
            release_id=release_id,
            audio_playback=bool(
                publication_policy["characterMedia"]["audioPlayback"]
            ),
            live2d_runtime_report=live2d_runtime_report,
        )
        merged_media_capabilities = merge_media_capabilities(
            story_pipeline.media_capabilities,
            character_media.capabilities,
            release_id=release_id,
        )
    for asset in assets:
        label = asset_labels.get(asset["id"])
        if label:
            asset["displayName"] = label
            asset["catalogStatus"] = "identified"
            asset["classificationConfidence"] = 1.0
            asset["classificationReason"] = "verified_entity_label"
            asset["classificationEvidence"] = "master_or_projection_relation"
            asset["publicPolicy"] = "public"
    event_art_names = {
        f"Assets/AddressableResources/Image/Event/{path}.png": event["name"]
        for event in game_modes.get("events", {}).get("records", [])
        for kind in ("logo", "background")
        if (path := event.get("assets", {}).get(kind))
    }
    for asset in assets:
        if asset["containerPath"] in event_art_names:
            asset.update(displayName=event_art_names[asset["containerPath"]],
                         catalogStatus="identified", publicPolicy="public",
                         classificationConfidence=1.0,
                         classificationReason="verified_event_artwork",
                         classificationEvidence="MasterEvent._logoAsset/_backgroundAsset")
    if global_systems["status"] == "configured_snapshot":
        gacha_banner_names = {
            f"Assets/AddressableResources/{pool['bannerAssetName']}.png": pool["name"]
            for pool in global_systems["gachaPools"]
            if pool["bannerAssetName"]
        }
        bound_banners = set()
        for asset in assets:
            name = gacha_banner_names.get(asset["containerPath"])
            if name is None:
                continue
            if asset["containerPath"] in bound_banners:
                raise CatalogError("duplicate Gacha banner asset")
            bound_banners.add(asset["containerPath"])
            asset.update(
                displayName=name,
                catalogStatus="identified",
                classificationConfidence=1.0,
                classificationReason="verified_gacha_banner",
                classificationEvidence="MasterGacha._bannerAssetName",
                publicPolicy="public",
            )
        if bound_banners != set(gacha_banner_names):
            raise CatalogError("formal Gacha banner assets are incomplete")

    bands = apply_entity_overrides(
        entities["bands"],
        load_json(overrides_root / "bands.json", {}),
        "band",
        protected_fields=("id", "masterId", "characterIds"),
    )
    characters = apply_entity_overrides(
        entities["characters"],
        load_json(overrides_root / "characters.json", {}),
        "character",
        protected_fields=(
            "id",
            "masterId",
            "bandId",
            "profileAssetId",
            "portraitAssetIds",
            "memberCardIds",
            "featuredSupportCardIds",
            "sourceBundle",
        ),
    )
    member_override_path = overrides_root / "member-cards.json"
    legacy_override_path = overrides_root / "cards.json"
    used_legacy_card_overrides = (
        not member_override_path.exists() and legacy_override_path.exists()
    )
    member_cards = apply_entity_overrides(
        entities["memberCards"],
        load_json(
            legacy_override_path
            if used_legacy_card_overrides
            else member_override_path,
            {},
        ),
        "member card",
        protected_fields=(
            "id",
            "masterId",
            "assetId",
            "characterId",
            "primaryAssetId",
            "variantAssetIds",
            "sourceBundle",
            "sourceContainerPath",
        ),
    )
    support_cards = apply_entity_overrides(
        entities["supportCards"],
        load_json(overrides_root / "support-cards.json", {}),
        "support card",
        protected_fields=(
            "id",
            "masterId",
            "assetId",
            "featuredCharacterIds",
            "primaryAssetId",
            "variantAssetIds",
            "sourceBundle",
            "sourceContainerPath",
        ),
    )
    editorial = load_json(overrides_root / "editorial.json", {})

    story_status = (
        "published"
        if story_pipeline and story_pipeline.database.get("chapters")
        else "reserved"
    )
    story_counts = (
        story_pipeline.quality_report if story_pipeline else {}
    )
    entity_variants = build_entity_variants(
        build_context,
        (
            ("band", bands, "displayName"),
            ("character", characters, "displayName"),
            ("memberCard", member_cards, "displayName"),
            ("supportCard", support_cards, "displayName"),
            ("music", music_tracks, "title"),
        ),
    )
    public_assets = [
        asset for asset in assets if asset.get("publicPolicy") != "not_public"
    ]
    catalog = {
        "schemaVersion": 6,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "release": build_context.release,
        "projectionContext": {
            "contentReleaseId": release_id,
            "region": build_context.region,
            "channel": build_context.channel,
            "locale": build_context.locale,
        },
        "editorial": editorial,
        "cardTaxonomy": card_taxonomy,
        "modules": [
            {
                "id": "catalog",
                "displayName": "角色与卡牌",
                "status": "published",
                "route": "/catalog/",
            },
            {
                "id": "resources",
                "displayName": "资源中心",
                "status": "published",
                "route": "/resources/",
            },
            {
                "id": "music",
                "displayName": "音乐资料",
                "status": "published" if music_tracks else "reserved",
                "route": "/music/",
            },
            {
                "id": "database",
                "displayName": "游戏数据库",
                "status": (
                    "published"
                    if game_database.get("skills")
                    else "reserved"
                ),
                "route": "/database/",
            },
            {
                "id": "stories",
                "displayName": "剧情档案",
                "status": story_status,
                "route": "/stories/",
            },
        ],
        "bands": bands,
        "characters": characters,
        "memberCards": member_cards,
        "supportCards": support_cards,
        "musicTracks": music_tracks,
        "musicCharts": music_charts,
        "entityVariants": entity_variants,
        "canonicalEntities": [],
        "publicationPolicy": {
            "music": publication_policy["music"],
            "characterMedia": (
                publication_policy["characterMedia"]
                if publication_policy.get("characterMedia")
                else {
                    "enabled": False,
                    "audioPlayback": False,
                    "audioDownload": False,
                    "live2dPlayback": False,
                }
            ),
        },
        "story": (
            {
                "chapterCount": story_counts.get("chapterCount", 0),
                "entryCount": story_counts.get("entryCount", 0),
                "entriesByKind": story_counts.get("entriesByKind", {}),
                "advStateCounts": story_counts.get("advStateCounts", {}),
                "availableAdvCount": len(
                    story_counts.get("availableAdvIds", [])
                ),
            }
            if story_pipeline
            else {
                "chapterCount": 0,
                "entryCount": 0,
                "entriesByKind": {},
                "advStateCounts": {},
                "availableAdvCount": 0,
            }
        ),
        "characterMedia": (
            character_media.database.get("quality", {})
            if character_media
            else {
                "costumeCount": 0,
                "voiceCount": 0,
                "talkCount": 0,
                "friendshipCount": 0,
                "mediaItemCount": 0,
            }
        ),
        "assets": public_assets,
    }
    errors = validate_catalog(catalog)
    errors.extend(validate_game_database_links(catalog, card_projections))
    if errors:
        raise CatalogError("; ".join(errors))
    unified_search_index = build_unified_search_index(
        catalog,
        story_pipeline.search_index if story_pipeline else None,
        release_id,
    )

    report = {
        "generatedAt": catalog["generatedAt"],
        "manifest": str(manifest_path),
        "textureRecordCount": len(all_records),
        "publishedAssetCount": len(public_assets),
        "excludedAssetCount": len(assets) - len(public_assets),
        "bandCount": len(bands),
        "characterCount": len(characters),
        "memberCardCount": len(member_cards),
        "supportCardCount": len(support_cards),
        "musicTrackCount": len(music_tracks),
        "musicChartCount": len(music_charts),
        "musicScoreRuntimeClassificationCounts": {
            classification: sum(
                chart.get("fullComboClassification") == classification
                for chart in music_charts
            )
            for classification in (
                "MATCH",
                "RUNTIME_HIGHER",
                "RUNTIME_LOWER",
            )
        },
        "musicScoreRuntimeReport": [
            {
                "chartId": chart["id"],
                "scoreLogicalPath": chart["scoreLogicalPath"],
                "runtimeAlgorithmVersion": chart[
                    "runtimeAlgorithmVersion"
                ],
                "oldPublishedFullCombo": chart["masterFullComboCount"],
                "masterFullComboCount": chart["masterFullComboCount"],
                "runtimeFullCombo": chart["fullComboCount"],
                "delta": chart["fullComboDelta"],
                "classification": chart["fullComboClassification"],
                "explicitJudgementCount": chart[
                    "explicitJudgementCount"
                ],
                "slideComboCandidateCount": chart[
                    "slideComboCandidateCount"
                ],
                "skippedSlideComboCount": chart[
                    "skippedSlideComboCount"
                ],
                "mergedEndpointReduction": chart[
                    "mergedEndpointReduction"
                ],
                "guidePathCount": chart["guidePathCount"],
                "autoControlNodeCount": chart[
                    "autoControlNodeCount"
                ],
                "firstTimelineDifference": None,
            }
            for chart in music_charts
        ],
        "musicAudioTrackCount": (
            sum(1 for track in music_tracks if track.get("audioPlayback"))
            if music_audio_playback
            else 0
        ),
        "musicAudioPublishCount": len(music_audio_records),
        "skillCount": len(game_database.get("skills", [])),
        "itemCount": len(game_database.get("items", [])),
        "growthProfileCount": len(
            game_database.get("growthProfiles", [])
        ),
        "bandItemCount": len(band_item_database.get("items", [])),
        "bandItemLevelCount": sum(
            len(item.get("levels", []))
            for item in band_item_database.get("items", [])
        ),
        "missingBandItemAssetCount": int(
            band_item_database.get("quality", {}).get(
                "missingAssetCount", 0
            )
        ),
        "memberCardProjectionCount": len(
            card_projections.get("memberCards", [])
        ),
        "supportCardProjectionCount": len(
            card_projections.get("supportCards", [])
        ),
        "partialSkillCount": int(
            game_database.get("quality", {}).get("partialSkillCount", 0)
        ),
        "missingItemIconCount": sum(
            item.get("catalogStatus") == "missing_asset"
            for item in game_database.get("items", [])
        ),
        "missingSkillIconCount": sum(
            skill.get("iconAssetId") is None
            for skill in game_database.get("skills", [])
        ),
        "unexplainedMissingSkillIconCount": int(
            game_database.get("quality", {}).get(
                "unexplainedMissingSkillIconCount", 0
            )
        ),
        "pendingAssetCount": sum(
            asset["catalogStatus"] == "pending" for asset in assets
        ),
        "unexplainedPendingAssetCount": sum(
            asset["catalogStatus"] == "pending" for asset in assets
        ),
        "assetClassificationCounts": {
            status: sum(
                asset["catalogStatus"] == status for asset in assets
            )
            for status in (
                "identified",
                "archive_only",
                "source_placeholder",
                "pending",
            )
        },
        "pendingCharacterCount": sum(
            character["catalogStatus"] != "identified"
            for character in characters
        ),
        "pendingMemberCardCount": sum(
            card["catalogStatus"] != "identified" for card in member_cards
        ),
        "pendingSupportCardCount": sum(
            card["catalogStatus"] != "identified" for card in support_cards
        ),
        "warnings": [
            *(
            ["catalog/overrides/cards.json is deprecated"]
            if used_legacy_card_overrides
            else []
            ),
            *music_warnings,
            *game_warnings,
            *band_item_warnings,
            *(story_pipeline.warnings if story_pipeline else []),
            *(character_media.warnings if character_media else []),
            *music_audio_warnings,
            *(f"music audio rejected: {item['trackId']} ({item['reason']})"
              for item in music_audio_rejected),
        ],
        "validationErrors": [],
        "languageCoverage": (
            language_coverage(master.texts.values(), build_context.locale)
            if not assets_only
            else language_coverage([], build_context.locale)
        ),
    }
    compare_published_music_timelines(
        report,
        music_chart_data,
        published_music_data_root,
    )
    return SiteProjectionBuild(
        catalog=catalog,
        artifacts=SiteProjectionArtifacts(
            music_chart_data=music_chart_data,
            game_database=game_database,
            game_modes=game_modes,
            global_systems=global_systems,
            high_score_rating=high_score_rating,
            arena_rank=arena_rank,
            unified_search_index=unified_search_index,
            card_detail_projections=card_projections,
            band_item_database=band_item_database,
            band_item_quality_report=(
                band_item_build.quality_report if band_item_build else None
            ),
            story_database=(
                story_pipeline.database if story_pipeline else None
            ),
            story_search_index=(
                story_pipeline.search_index if story_pipeline else None
            ),
            media_capabilities=merged_media_capabilities,
            story_quality_report=(
                story_pipeline.quality_report if story_pipeline else None
            ),
            character_media_database=(
                character_media.database if character_media else None
            ),
            character_media_projections=(
                character_media.projections if character_media else None
            ),
            character_media_search_index=(
                character_media.search_index if character_media else None
            ),
            character_media_quality_report=(
                character_media.quality_report if character_media else None
            ),
        ),
        publications=SiteProjectionPublications(
            character_audio=(
                character_media.audio_publications if character_media else []
            ),
            character_textures=(
                character_media.texture_publications if character_media else []
            ),
        ),
        quality_report=report,
    )


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_release_projection(
    *,
    generated_root: Path,
    public_data_root: Path,
    context: BuildContext,
    build: SiteProjectionBuild,
) -> None:
    """Publish an immutable release/locale projection plus an active index."""
    validate_artifact("catalog.json", build.catalog)
    relative = Path("releases") / context.content_release_id / context.locale
    generated_release_root = generated_root / relative
    public_release_root = public_data_root / relative
    artifacts = build.artifacts.release_files(build.catalog)
    for filename, value in artifacts.items():
        if value is None:
            continue
        write_json(generated_release_root / filename, value)
        write_json(public_release_root / filename, value)

    index_path = generated_root / "release-index.json"
    existing = load_json(index_path, {})
    entries = existing.get("projections", []) if isinstance(existing, dict) else []
    if not isinstance(entries, list):
        entries = []
    entry = {
        "contentReleaseId": context.content_release_id,
        "region": context.region,
        "channel": context.channel,
        "locale": context.locale,
        "catalogPath": f"/data/{relative.as_posix()}/catalog.json",
    }
    entries = [
        item
        for item in entries
        if not (
            isinstance(item, dict)
            and item.get("region") == context.region
            and item.get("locale") == context.locale
        )
    ]
    entries.append(entry)
    index = {
        "schemaVersion": 1,
        "active": entry,
        "projections": sorted(
            entries,
            key=lambda item: (
                str(item.get("region", "")),
                str(item.get("channel", "")),
                str(item.get("contentReleaseId", "")),
                str(item.get("locale", "")),
            ),
        ),
    }
    validate_artifact("release-index.json", index)
    write_json(index_path, index)
    write_json(public_data_root / "release-index.json", index)


def write_character_audio(
    publications: list[dict[str, Any]],
    media_root: Path,
    *,
    skip_media: bool,
) -> None:
    if skip_media:
        return
    audio_root = media_root / "audio"
    audio_root.mkdir(parents=True, exist_ok=True)
    desired = {f"{item['id']}.flac" for item in publications}
    for existing in audio_root.glob("audio-*.flac"):
        if existing.name not in desired:
            existing.unlink()
    for item in publications:
        source = Path(item["source"])
        if not source.is_file():
            raise CharacterMediaError(
                f"character audio source disappeared: {source}"
            )
        target = audio_root / f"{item['id']}.flac"
        if target.exists() and file_sha256(target) == file_sha256(source):
            continue
        if target.exists():
            target.unlink()
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)


def write_character_textures(
    publications: list[dict[str, Any]],
    media_root: Path,
    *,
    skip_media: bool,
) -> None:
    if skip_media:
        return
    texture_root = media_root / "character-textures"
    texture_root.mkdir(parents=True, exist_ok=True)
    desired = {f"{item['id']}.png" for item in publications}
    for existing in texture_root.glob("character-texture-*.png"):
        if existing.name not in desired:
            existing.unlink()
    for item in publications:
        source = Path(item["source"])
        if not source.is_file():
            raise CharacterMediaError(
                f"character texture source disappeared: {source}"
            )
        if file_sha256(source) != item["sha256"]:
            raise CharacterMediaError(
                f"character texture source hash changed: {item['id']}"
            )
        target = texture_root / f"{item['id']}.png"
        if target.exists() and file_sha256(target) == item["sha256"]:
            continue
        if target.exists():
            target.unlink()
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)
