"""Publish a validated, server-labelled ranking export atomically."""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.player_rankings import (SERVERS, final_archive_metadata, final_archive_paths,
                                     validate_observation)


def publish(source: Path, root: Path, server: str) -> Path:
    return publish_observation(json.loads(source.read_text()), root, server)


def publish_observation(value: dict, root: Path, server: str) -> Path:
    value = validate_observation(value, server)
    target = root / server / "current.json"
    new_directory = not target.parent.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    if new_directory:
        # Capture may run with a private umask; the public read-only service
        # needs traversal of the newly created, public observations directory.
        os.chmod(target.parent, 0o755)
    fd, temporary = tempfile.mkstemp(prefix=".ranking-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        # The public read-only service runs under a separate, unprivileged UID.
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
    return target


def _create_immutable(path: Path, raw: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix='.ranking-final-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def ensure_final_archive_metadata(root: Path, server: str, event_id: str) -> bool:
    """Complete an archive whose data was created before a crash or deployment."""
    target, sidecar = final_archive_paths(root, server, event_id)
    if not target.is_file():
        return False
    raw = target.read_bytes()
    metadata = final_archive_metadata(json.loads(raw), server, raw)
    if metadata['eventId'] != event_id:
        raise ValueError('final ranking event mismatch')
    if sidecar.exists():
        if json.loads(sidecar.read_text()) != metadata:
            raise ValueError('final ranking metadata mismatch')
    else:
        _create_immutable(sidecar, json.dumps(metadata, ensure_ascii=False).encode())
    return True


def publish_final_observation(value: dict, root: Path, server: str) -> Path:
    """Create one immutable post-event snapshot without changing current.json."""
    raw = json.dumps(validate_observation(value, server), ensure_ascii=False).encode()
    metadata = final_archive_metadata(value, server, raw)
    target, _ = final_archive_paths(root, server, metadata['eventId'])
    new_directory = not target.parent.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    if new_directory:
        os.chmod(target.parent, 0o755)
    if not target.exists():
        _create_immutable(target, raw)
    ensure_final_archive_metadata(root, server, metadata['eventId'])
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--root", required=True, type=Path, help="Query data root / observations")
    parser.add_argument("--server", required=True, choices=sorted(SERVERS))
    args = parser.parse_args()
    print(publish(args.source, args.root, args.server))
