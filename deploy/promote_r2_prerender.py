"""Promote two fully staged prerenders while the host orchestration lock is held."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re

from tools.publish_prerender import read_inputs


PAIR = re.compile(r"[a-f0-9]{24}-[a-f0-9]{24}\Z")


def _link_target(root: Path, name: str) -> str | None:
    path = root / name
    if path.exists() and not path.is_symlink():
        raise ValueError(f"{name} is not a symlink")
    if not path.is_symlink():
        return None
    target = os.readlink(path)
    if not re.fullmatch(r"releases/[a-f0-9]{24}-[a-f0-9]{24}", target):
        raise ValueError(f"unsafe {name} target")
    return target


def _switch(root: Path, name: str, target: str | None) -> None:
    path = root / name
    temporary = root / ("." + name + ".r2-next")
    if temporary.exists() or temporary.is_symlink():
        raise ValueError(f"stale {temporary.name}")
    if target is None:
        path.unlink(missing_ok=True)
        return
    temporary.symlink_to(target)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def promote(code_root: Path, content: Path, stage: Path, rendered: Path) -> dict:
    code_root, content, stage, rendered = (p.resolve(strict=True) for p in
                                          (code_root, content, stage, rendered))
    if stage.parent != rendered or stage.name[:10] != ".r2-stage-":
        raise ValueError("stage must be directly under the rendered root")
    releases = rendered / "releases"
    if releases.is_symlink():
        raise ValueError("linked rendered releases directory")
    releases.mkdir(exist_ok=True)
    ready = {}
    for region, suffix in (("global", ""), ("jp", "-jp")):
        pointer_path = content / ("current.json" if region == "global" else "jp/current.json")
        if not pointer_path.is_file():
            raise ValueError(f"{region} current pointer is absent")
        _code, metadata, pointer_bytes, pair = read_inputs(code_root, content, region)
        if not PAIR.fullmatch(pair):
            raise ValueError("invalid rendered pair")
        target = "releases/" + pair
        if _link_target(stage, "current" + suffix) != target:
            raise ValueError(f"{region} stage was not published")
        staged = stage / target
        if staged.is_symlink() or not staged.is_dir() or not (staged / region).is_dir():
            raise ValueError(f"{region} stage release is absent")
        complete = json.loads((staged / "complete.json").read_text())
        if (complete.get("schemaVersion") != 1 or complete.get("pair") != pair or
                complete.get("codeId") != metadata["codeId"] or
                complete.get("region") != region or
                complete.get("pointer") != json.loads(pointer_bytes)):
            raise ValueError(f"{region} staged release differs from inputs")
        destination = releases / pair
        if destination.is_symlink():
            raise ValueError("linked rendered release")
        if destination.exists():
            existing = json.loads((destination / "complete.json").read_text())
            if existing != complete or not (destination / region).is_dir():
                raise ValueError("conflicting rendered release")
        ready[region] = (target, staged, destination)
    # Check both regions before changing any serving pointer. Releases are
    # immutable; an interrupted move leaves at most an unreferenced release.
    for target, staged, destination in ready.values():
        if not destination.exists():
            os.replace(staged, destination)
    old = {name: _link_target(rendered, name)
           for name in ("current", "current-jp", "previous", "previous-jp")}
    changed = []
    try:
        for region, suffix in (("global", ""), ("jp", "-jp")):
            name = "current" + suffix
            target = ready[region][0]
            if old[name] == target:
                continue
            _switch(rendered, "previous" + suffix, old[name])
            changed.append("previous" + suffix)
            _switch(rendered, name, target)
            changed.append(name)
    except Exception:
        # The host wrapper holds one exclusive lock; the old timer must be
        # stopped before this script runs, so restoring these names has no race.
        for name in reversed(changed):
            _switch(rendered, name, old[name])
        raise
    return {region: ready[region][0] for region in ready}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--content", type=Path, required=True)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--rendered", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(promote(args.code_root, args.content, args.stage, args.rendered),
                     sort_keys=True))


if __name__ == "__main__":
    main()
