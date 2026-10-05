#!/usr/bin/env python3
"""Generate web media derivatives and a unified three-tier media index."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 1
VALID_STATES = {
    "available",
    "private",
    "source_missing",
    "unsupported_format",
    "not_applicable",
}


class MediaDerivativeError(RuntimeError):
    """Raised when a derivative or media-tier contract is invalid."""


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _value_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_pillow() -> Any:
    try:
        from PIL import Image  # type: ignore
    except ModuleNotFoundError:
        dependency_dir = REPO_ROOT / "analysis/.deps"
        if dependency_dir.is_dir():
            import sys

            sys.path.insert(0, str(dependency_dir))
        from PIL import Image  # type: ignore
    return Image


def _variant(path: Path, public_root: Path, width: int, height: int) -> dict[str, Any]:
    return {
        "url": f"/{path.relative_to(public_root).as_posix()}",
        "width": width,
        "height": height,
        "byteSize": path.stat().st_size,
        "sha256": _file_sha256(path),
        "mimeType": "image/webp",
    }


def generate_image_derivatives(
    catalog: Mapping[str, Any],
    public_root: Path,
) -> dict[str, list[dict[str, Any]]]:
    Image = _load_pillow()
    from tools.conversion_cache import restore as cache_restore, save as cache_save, image_recipe
    from tools.media_parallel import map_images
    target_root = public_root / "media/responsive"
    target_root.mkdir(parents=True, exist_ok=True)
    def convert(asset):
        asset_id = str(asset["id"])
        original_url = str(asset.get("originalUrl") or "")
        original = public_root / original_url.lstrip("/")
        if not original.is_file():
            raise MediaDerivativeError(f"image original missing: {asset_id}")
        variants: list[dict[str, Any]] = []
        source_sha = _file_sha256(original)
        with Image.open(original) as source:
            source_width, source_height = source.size
            widths = sorted({min(source_width, width) for width in (320, 640, 1200, 1920)})
            for width in widths:
                height = max(1, round(source_height * width / source_width))
                target = target_root / f"{asset_id}-{width}w.webp"
                recipe = image_recipe(f'responsive-webp-{width}-q{84 if width > 640 else 76}-m6-v1')
                cached = cache_restore(source_sha, recipe, target)
                valid_target = target.is_file()
                if valid_target:
                    try:
                        with Image.open(target) as existing:
                            existing.verify()
                    except Exception:
                        valid_target = False
                if not cached or not valid_target:
                    image = source.copy()
                    image.thumbnail((width, height), Image.Resampling.LANCZOS)
                    if image.mode not in {"RGB", "RGBA"}:
                        image = image.convert("RGBA")
                    temporary = target.with_name(f"{target.stem}.tmp.webp")
                    image.save(temporary, "WEBP", quality=84 if width > 640 else 76, method=6)
                    temporary.replace(target)
                cache_save(source_sha, recipe, target)
                with Image.open(target) as generated:
                    actual_width, actual_height = generated.size
                variants.append(
                    _variant(target, public_root, actual_width, actual_height)
                )
        return asset_id, variants
    return dict(map_images(convert, catalog.get("assets", [])))


def generate_audio_previews(
    character_media: Mapping[str, Any],
    public_root: Path,
    ffmpeg: str | None,
) -> dict[str, dict[str, Any]]:
    source_urls = {
        str(item.get("audioUrl"))
        for key in ("voices", "talks", "liveDialogues")
        for item in character_media.get(key, [])
        if str(item.get("audioUrl") or "").endswith(".flac")
    }
    if source_urls and not ffmpeg:
        raise MediaDerivativeError("ffmpeg missing for character audio previews")
    target_root = public_root / "media/audio-preview"
    target_root.mkdir(parents=True, exist_ok=True)
    previews = {}
    for source_url in sorted(source_urls):
        source = public_root / source_url.lstrip("/")
        if not source.is_file():
            raise MediaDerivativeError(f"character audio source missing: {source_url}")
        target = target_root / f"{source.stem}.m4a"
        if not target.is_file() or target.stat().st_mtime < source.stat().st_mtime:
            temporary = target.with_name(f"{target.stem}.tmp.m4a")
            completed = subprocess.run(
                [
                    str(ffmpeg),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-movflags",
                    "+faststart",
                    str(temporary),
                ],
                capture_output=True,
                text=True,
            )
            if completed.returncode:
                raise MediaDerivativeError(
                    f"ffmpeg audio preview failed: {completed.stderr[-500:]}"
                )
            temporary.replace(target)
        previews[source_url] = {
            "url": f"/{target.relative_to(public_root).as_posix()}",
            "mimeType": "audio/mp4",
            "codec": "aac",
            "bitrateKbps": 128,
            "byteSize": target.stat().st_size,
            "sha256": _file_sha256(target),
        }
    return previews


def generate_video_posters(
    device_archive: Mapping[str, Any],
    public_root: Path,
    ffmpeg: str | None,
) -> dict[str, dict[str, Any]]:
    videos = [
        (item, output)
        for item in device_archive.get("items", [])
        for output in item.get("outputs", [])
        if output.get("mediaType") == "video"
    ]
    if videos and not ffmpeg:
        raise MediaDerivativeError("ffmpeg missing for video posters")
    target_root = public_root / "media/posters"
    target_root.mkdir(parents=True, exist_ok=True)
    posters = {}
    for item, output in videos:
        item_id = str(item["id"])
        source = public_root / str(output["url"]).lstrip("/")
        target = target_root / f"{item_id}.webp"
        if not target.is_file() or target.stat().st_mtime < source.stat().st_mtime:
            temporary_png = target.with_name(f"{target.stem}.tmp.png")
            completed = subprocess.run(
                [
                    str(ffmpeg),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    "0",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(1280,iw)':-2",
                    str(temporary_png),
                ],
                capture_output=True,
                text=True,
            )
            if completed.returncode:
                raise MediaDerivativeError(
                    f"ffmpeg video poster failed: {completed.stderr[-500:]}"
                )
            Image = _load_pillow()
            temporary_webp = target.with_name(f"{target.stem}.tmp.webp")
            with Image.open(temporary_png) as image:
                image.save(temporary_webp, "WEBP", quality=82, method=6)
            temporary_webp.replace(target)
            temporary_png.unlink(missing_ok=True)
        Image = _load_pillow()
        with Image.open(target) as image:
            width, height = image.size
        posters[item_id] = _variant(target, public_root, width, height)
    return posters


def _original_tier(asset: Mapping[str, Any]) -> dict[str, Any]:
    if asset.get("downloadPolicy") == "preview_and_download":
        return {
            "state": "available",
            "url": asset.get("originalUrl"),
            "mimeType": "image/png",
            "byteSize": asset.get("byteSize"),
            "sha256": asset.get("sha256"),
            "activation": "explicit_download",
        }
    return {"state": "private", "url": None, "activation": "unavailable"}


def build_media_index(
    catalog: Mapping[str, Any],
    character_media: Mapping[str, Any],
    device_archive: Mapping[str, Any],
    live2d_models: Mapping[str, Any],
    image_derivatives: Mapping[str, list[dict[str, Any]]],
    audio_previews: Mapping[str, dict[str, Any]],
    video_posters: Mapping[str, dict[str, Any]],
) -> dict[str, Any]:
    release_id = str(
        catalog.get("projectionContext", {}).get("contentReleaseId")
        or catalog.get("release", {}).get("id")
        or ""
    )
    records: list[dict[str, Any]] = []
    for asset in catalog.get("assets", []):
        variants = list(image_derivatives.get(str(asset["id"]), []))
        list_variant = variants[0] if variants else {
            "url": asset.get("thumbnailUrl"),
            "width": min(int(asset.get("width") or 0), 320),
            "height": min(int(asset.get("height") or 0), 320),
            "mimeType": "image/webp",
        }
        preview_variants = variants[1:] or variants or [
            {
                "url": asset.get("previewUrl"),
                "width": int(asset.get("width") or 0),
                "height": int(asset.get("height") or 0),
                "mimeType": "image/webp",
            }
        ]
        records.append(
            {
                "id": str(asset["id"]),
                "kind": "image",
                "owner": {"kind": "asset", "id": str(asset["id"])},
                "publicPolicy": asset.get("publicPolicy", "public"),
                "sourceSha256": asset.get("sha256"),
                "tiers": {
                    "list": {"state": "available", **list_variant},
                    "webPreview": {
                        "state": "available",
                        "activation": "page_render",
                        "variants": preview_variants,
                    },
                    "original": _original_tier(asset),
                },
            }
        )

    character_audio_owners: dict[str, list[dict[str, str]]] = defaultdict(list)
    for key in ("voices", "talks", "liveDialogues"):
        for item in character_media.get(key, []):
            source_url = str(item.get("audioUrl") or "")
            if source_url:
                character_audio_owners[source_url].append(
                    {"kind": key, "id": str(item.get("id"))}
                )
    for source_url, owners in sorted(character_audio_owners.items()):
        preview = audio_previews.get(source_url)
        records.append(
            {
                "id": f"character-audio-{hashlib.sha256(source_url.encode()).hexdigest()[:16]}",
                "kind": "audio",
                "owners": owners,
                "publicPolicy": "preview_and_download",
                "tiers": {
                    "poster": {"state": "not_applicable", "url": None},
                    "webPreview": {
                        "state": "available" if preview else "source_missing",
                        "activation": "explicit",
                        **(preview or {"url": None}),
                    },
                    "original": {
                        "state": "available",
                        "url": source_url,
                        "mimeType": "audio/flac",
                        "activation": "explicit_download",
                    },
                },
            }
        )
    for track in catalog.get("musicTracks", []):
        if not track.get("audioUrl"):
            continue
        records.append(
            {
                "id": f"music-audio-{track['id']}",
                "kind": "audio",
                "owner": {"kind": "music", "id": str(track["id"])},
                "publicPolicy": "preview_only",
                "tiers": {
                    "poster": {"state": "not_applicable", "url": None},
                    "webPreview": {
                        "state": "available",
                        "activation": "explicit",
                        "url": track["audioUrl"],
                        "mimeType": "audio/mp4",
                        "codec": track.get("audioCodec"),
                        "durationSeconds": track.get("audioDuration"),
                    },
                    "original": {"state": "private", "url": None},
                },
            }
        )
    for item in device_archive.get("items", []):
        for output in item.get("outputs", []):
            media_type = str(output.get("mediaType"))
            if media_type not in {"audio", "video"}:
                continue
            poster = video_posters.get(str(item["id"])) if media_type == "video" else None
            records.append(
                {
                    "id": f"{item['id']}-{int(output.get('stream', 0))}",
                    "kind": media_type,
                    "owner": {"kind": "device_media", "id": str(item["id"])},
                    "publicPolicy": "preview_only",
                    "sourceSha256": item.get("sourceSha256"),
                    "tiers": {
                        "poster": (
                            {"state": "available", **poster}
                            if poster
                            else {"state": "not_applicable" if media_type == "audio" else "source_missing", "url": None}
                        ),
                        "webPreview": {
                            "state": "available",
                            "activation": "explicit",
                            "url": output.get("url"),
                            "byteSize": output.get("byteSize"),
                            "sha256": output.get("sha256"),
                            "durationSeconds": output.get("durationSeconds"),
                            "mimeType": "video/mp4" if media_type == "video" else "audio/mp4",
                        },
                        "original": {"state": "private", "url": None},
                    },
                }
            )
    assets_by_id = {
        str(asset["id"]): asset for asset in catalog.get("assets", [])
    }
    character_posters = {
        int(character["masterId"]): assets_by_id.get(
            str(character.get("profileAssetId") or "")
        )
        for character in catalog.get("characters", [])
    }
    for model in live2d_models.get("models", []):
        state = str(model.get("state"))
        character_match = re.match(r"^(\d{3})_", str(model.get("modelId")))
        poster_asset = (
            character_posters.get(int(character_match.group(1)))
            if character_match
            else None
        )
        poster = (
            {
                "state": "available",
                "url": poster_asset.get("previewUrl"),
                "mimeType": "image/webp",
                "evidence": "build_time_character_profile_poster",
                "isModelRender": False,
            }
            if poster_asset
            else {
                "state": "source_missing",
                "url": None,
                "reason": "finished_model_poster_not_available",
            }
        )
        records.append(
            {
                "id": f"live2d-{hashlib.sha256(str(model.get('modelId')).encode()).hexdigest()[:16]}",
                "kind": "live2d",
                "owner": {"kind": "live2d_model", "id": str(model.get("modelId"))},
                "publicPolicy": "explicit_activation",
                "sourceSha256": model.get("mocSha256"),
                "tiers": {
                    "poster": poster,
                    "webPreview": {
                        "state": "available" if state == "available" else "unsupported_format",
                        "activation": "explicit",
                        "url": model.get("modelUrl") if state == "available" else None,
                        "mimeType": "application/json",
                    },
                    "original": {"state": "private", "url": None},
                },
            }
        )
    records.sort(key=lambda record: record["id"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "contentReleaseId": release_id,
        "recordCount": len(records),
        "sha256": _value_sha256(records),
        "records": records,
        "bySourceUrl": {
            source_url: preview["url"]
            for source_url, preview in sorted(audio_previews.items())
        },
    }


def validate_media_index(index: Mapping[str, Any]) -> None:
    records = list(index.get("records", []))
    ids = [record.get("id") for record in records]
    if len(ids) != len(set(ids)):
        raise MediaDerivativeError("duplicate media record id")
    for record in records:
        tiers = record.get("tiers", {})
        for name, tier in tiers.items():
            if tier.get("state") not in VALID_STATES:
                raise MediaDerivativeError(
                    f"invalid media tier state: {record.get('id')} {name}"
                )
        original_url = str(tiers.get("original", {}).get("url") or "")
        preview = tiers.get("webPreview", {})
        preview_urls = [str(preview.get("url") or "")]
        preview_urls.extend(
            str(variant.get("url") or "")
            for variant in preview.get("variants", [])
        )
        if original_url and original_url in preview_urls:
            raise MediaDerivativeError(
                f"web preview uses original fallback: {record.get('id')}"
            )
    if index.get("sha256") and index.get("sha256") != _value_sha256(records):
        raise MediaDerivativeError("media index digest mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "site/src/data/generated/catalog.json")
    parser.add_argument("--character-media", type=Path, default=REPO_ROOT / "site/src/data/generated/character-media.json")
    parser.add_argument("--device-media", type=Path, default=REPO_ROOT / "site/src/data/generated/device-media-archive.json")
    parser.add_argument("--live2d-models", type=Path, default=REPO_ROOT / "site/src/data/generated/live2d-models.json")
    parser.add_argument("--public-root", type=Path, default=REPO_ROOT / "site/public")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "site/src/data/generated/media-index.json")
    parser.add_argument("--public-output", type=Path, default=REPO_ROOT / "site/public/data/media-index.json")
    parser.add_argument("--report", type=Path, default=REPO_ROOT / "output/readiness/media-index.json")
    parser.add_argument("--core-only", action="store_true", help="Generate only catalog image derivatives; skip archive audio, video and Live2D.")
    args = parser.parse_args()

    catalog = _read_json(args.catalog, {})
    character_media = _read_json(args.character_media, {})
    device_archive = _read_json(args.device_media, {"items": []})
    live2d_models = _read_json(args.live2d_models, {"models": []})
    if args.core_only:
        catalog = {**catalog, "musicTracks": []}
        character_media = {}
        device_archive = {"items": []}
        live2d_models = {"models": []}
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None and Path("/opt/homebrew/bin/ffmpeg").is_file():
        ffmpeg = "/opt/homebrew/bin/ffmpeg"
    image_derivatives = generate_image_derivatives(catalog, args.public_root)
    audio_previews = generate_audio_previews(character_media, args.public_root, ffmpeg)
    video_posters = generate_video_posters(device_archive, args.public_root, ffmpeg)
    index = build_media_index(
        catalog,
        character_media,
        device_archive,
        live2d_models,
        image_derivatives,
        audio_previews,
        video_posters,
    )
    validate_media_index(index)
    _write_json(args.output, index)
    _write_json(args.public_output, index)
    counts = defaultdict(int)
    for record in index["records"]:
        counts[str(record["kind"])] += 1
    live2d_records = [
        record for record in index["records"] if record["kind"] == "live2d"
    ]
    available_live2d_posters = sum(
        record["tiers"]["poster"]["state"] == "available"
        for record in live2d_records
    )
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "passed",
        "contentReleaseId": index["contentReleaseId"],
        "recordCount": index["recordCount"],
        "sha256": index["sha256"],
        "counts": dict(sorted(counts.items())),
        "responsiveImageCount": len(image_derivatives),
        "characterAudioPreviewCount": len(audio_previews),
        "videoPosterCount": len(video_posters),
        "live2dPosterAvailableCount": available_live2d_posters,
        "live2dPosterMissingCount": len(live2d_records) - available_live2d_posters,
        "avifState": "unsupported_format",
        "originalFallbackCount": 0,
    }
    _write_json(args.report, report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
