"""Preserve only a failed Global compiler log in the private R2 bucket.

The log may contain private paths or unmasked upstream messages. Never print it,
put it in a public Actions artifact, or include exception text in CLI output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_JOURNAL_BYTES = 64 * 1024
_ID = re.compile(r'[1-9][0-9]{0,19}\Z')
_RUN_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\Z')
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def _open_absolute_directory(path: Path) -> int:
    """Open every component without following a directory symlink."""
    if not path.is_absolute() or '..' in path.parts or Path(os.path.normpath(path)) != path:
        raise ValueError('diagnostic workspace must be an absolute canonical path')
    directory = os.open('/', _DIR_FLAGS)
    try:
        for component in path.parts[1:]:
            next_directory = os.open(component, _DIR_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        return directory
    except BaseException:
        os.close(directory)
        raise


def _read_regular(parent: int, name: str, limit: int, *, tail: bool = False):
    descriptor = os.open(name, _FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('diagnostic source is not a regular file')
        if not tail and before.st_size > limit:
            raise ValueError('diagnostic journal exceeds its size limit')
        length = min(before.st_size, limit)
        offset = before.st_size - length if tail else 0
        chunks = []
        remaining = length
        while remaining:
            chunk = os.pread(descriptor, remaining, offset)
            if not chunk:
                raise ValueError('diagnostic source changed during read')
            chunks.append(chunk)
            remaining -= len(chunk)
            offset += len(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('diagnostic source changed during read')
        return b''.join(chunks), before.st_size
    finally:
        os.close(descriptor)


def read_compile_failure(workspace: Path):
    """Read the bounded tail for the one direct child named by latest-run.json."""
    workspace = Path(workspace)
    directory = _open_absolute_directory(workspace)
    try:
        try:
            raw, _ = _read_regular(directory, 'latest-run.json', MAX_JOURNAL_BYTES)
        except FileNotFoundError:
            return None
        report = json.loads(raw)
        if not isinstance(report, dict) or report.get('status') != 'failed' or report.get('failedStep') != 'compile-data':
            return None
        value = report.get('runDirectory')
        if not isinstance(value, str):
            raise ValueError('invalid diagnostic run directory')
        run = Path(value)
        if (run.parent != workspace / 'runs' or not _RUN_NAME.fullmatch(run.name)
                or '..' in run.parts or Path(os.path.normpath(run)) != run):
            raise ValueError('diagnostic run is not a direct child of workspace/runs')
        runs_fd = os.open('runs', _DIR_FLAGS, dir_fd=directory)
        try:
            run_fd = os.open(run.name, _DIR_FLAGS, dir_fd=runs_fd)
            try:
                try:
                    body, original = _read_regular(run_fd, 'compile-data.log', MAX_LOG_BYTES, tail=True)
                except FileNotFoundError:
                    return None
            finally:
                os.close(run_fd)
        finally:
            os.close(runs_fd)
        return {'body': body, 'originalBytes': original,
                'truncated': original > MAX_LOG_BYTES}
    finally:
        os.close(directory)


def preserve(workspace: Path, client, bucket: str, run_id: str, attempt: str) -> dict:
    """Upload an immutable log tail and verify its complete R2 readback."""
    if not isinstance(run_id, str) or not _ID.fullmatch(run_id):
        raise ValueError('invalid Actions run ID')
    if not isinstance(attempt, str) or not _ID.fullmatch(attempt):
        raise ValueError('invalid Actions run attempt')
    item = read_compile_failure(workspace)
    if item is None:
        return {'status': 'unavailable'}
    body = item['body']
    sha = hashlib.sha256(body).hexdigest()
    key = f'diagnostics/global/{run_id}/{attempt}/compile-data.log'
    metadata = {'sha256': sha, 'original-bytes': str(item['originalBytes']),
                'truncated': str(item['truncated']).lower()}
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentLength=len(body),
                      ContentType='application/octet-stream', CacheControl='no-store',
                      Metadata=metadata, IfNoneMatch='*')
    response = client.get_object(Bucket=bucket, Key=key)
    stream = response['Body']
    try:
        readback = stream.read(MAX_LOG_BYTES + 1)
    finally:
        stream.close()
    if (readback != body or hashlib.sha256(readback).hexdigest() != sha
            or response.get('ContentLength') != len(body)
            or response.get('Metadata') != metadata):
        raise ValueError('private diagnostic R2 readback mismatch')
    return {'status': 'stored', 'key': key, 'sha256': sha, 'bytes': len(body),
            'originalBytes': item['originalBytes'], 'truncated': item['truncated']}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--attempt', required=True)
    args = parser.parse_args(argv)
    try:
        from tools.r2_state import PrivateS3Bucket
        private = PrivateS3Bucket.from_environment()
        result = preserve(args.workspace, private.client, private.bucket,
                          args.run_id, args.attempt)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        # Even an exception string can contain a URL, private path, or credential.
        print('Private diagnostic preservation failed: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
