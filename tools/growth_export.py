"""Offline, allowlisted growth extraction for Global Android 1.0.1 (25).

This module has no networking or login capability. Input is a protobuf
GetPlayerDataResponse, optionally in one uncompressed gRPC frame. The wire
profile comes from client metadata constants and native serializers; see
packaging/growth-tool/README.md for the supported extraction workflow.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
MAX_FIELDS = 100_000
MAX_RECORDS = 10_000
MAX_SAFE_INTEGER = (1 << 53) - 1
PROFILE = "global-android-1.0.1-25"


class ExportError(ValueError):
    """Messages contain structural errors, never input values or server text."""


def fields(data: bytes):
    """Bounded wire reader. Unknown payloads are skipped without interpretation."""
    if len(data) > MAX_BYTES:
        raise ExportError("response_too_large")
    pos = 0
    count = 0

    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos == len(data):
                raise ExportError("truncated_varint")
            byte = data[pos]
            pos += 1
            if shift == 63 and byte > 1:
                raise ExportError("varint_overflow")
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
        raise ExportError("varint_overflow")

    while pos < len(data):
        count += 1
        if count > MAX_FIELDS:
            raise ExportError("too_many_fields")
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if not 0 < number < (1 << 29):
            raise ExportError("invalid_field_number")
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if size > len(data) - pos:
                raise ExportError("truncated_field")
            value = memoryview(data)[pos:pos + size]
            pos += size
        else:
            raise ExportError("unsupported_wire_type")
        yield number, wire, value


# (wire field, exported name, maximum). Account instance IDs and gain dates
# are deliberately excluded. Int64 public Master IDs must fit JavaScript.
MEMBER = {
    2: ("masterId", MAX_SAFE_INTEGER), 3: ("exp", (1 << 31) - 1),
    4: ("awakeCount", (1 << 31) - 1), 5: ("cardRank", (1 << 31) - 1),
    6: ("leaderSkillLevel", (1 << 31) - 1), 7: ("liveSkillLevel", (1 << 31) - 1),
    8: ("performanceSkillLevel", (1 << 31) - 1),
    10: ("linkSkillLevel", (1 << 31) - 1), 11: ("gekisouSkillLevel", (1 << 31) - 1),
}
SUPPORT = {2: ("masterId", MAX_SAFE_INTEGER), 3: ("exp", (1 << 31) - 1),
           5: ("cardRank", (1 << 31) - 1), 7: ("duplicateCount", (1 << 31) - 1)}
BAND_ITEM = {1: ("masterId", MAX_SAFE_INTEGER), 2: ("level", (1 << 31) - 1)}
CHARACTER = {1: ("characterId", MAX_SAFE_INTEGER), 2: ("exp", (1 << 31) - 1)}
VIP = {1: ("point", (1 << 31) - 1)}
COLLECTIONS = {
    2: ("memberCards", MEMBER, "masterId"),
    3: ("supportCards", SUPPORT, "masterId"),
    8: ("bandItems", BAND_ITEM, "masterId"),
    12: ("characterRanks", CHARACTER, "characterId"),
}


def scalar_record(data, spec, identity=None):
    # Proto3 scalar defaults are valid only inside an observed message.
    record = {name: 0 for name, _ in spec.values()}
    seen = set()
    for number, wire, value in fields(data):
        if number not in spec:
            continue
        name, maximum = spec[number]
        if wire != 0 or number in seen:
            raise ExportError("ambiguous_or_invalid_growth_field")
        if value > maximum:
            raise ExportError("growth_integer_out_of_range")
        seen.add(number)
        record[name] = value
    if identity and record[identity] <= 0:
        raise ExportError("missing_public_master_id")
    return record


def extract_growth(data: bytes, *, grpc_frame: bool = False) -> dict:
    if len(data) > MAX_BYTES:
        raise ExportError("response_too_large")
    if grpc_frame:
        if len(data) < 5 or data[0] != 0 or int.from_bytes(data[1:5], "big") != len(data) - 5:
            raise ExportError("expected_one_uncompressed_grpc_frame")
        data = data[5:]
    players = []
    for number, wire, value in fields(data):
        if number == 1:
            if wire != 2:
                raise ExportError("invalid_player_data")
            players.append(value)
    if len(players) != 1:
        raise ExportError("expected_exactly_one_player_data")
    growth = {name: None for name, _, _ in COLLECTIONS.values()}
    growth["tgw"] = None
    identities = {name: set() for name, _, _ in COLLECTIONS.values()}
    count = 0
    for number, wire, value in fields(players[0]):
        if number not in COLLECTIONS and number != 50:
            continue
        if wire != 2:
            raise ExportError("invalid_growth_message")
        count += 1
        if count > MAX_RECORDS:
            raise ExportError("too_many_growth_records")
        if number == 50:
            if growth["tgw"] is not None:
                raise ExportError("duplicate_tgw_message")
            growth["tgw"] = scalar_record(value, VIP)
            continue
        name, spec, identity = COLLECTIONS[number]
        record = scalar_record(value, spec, identity)
        if record[identity] in identities[name]:
            raise ExportError("duplicate_public_master_id")
        identities[name].add(record[identity])
        if growth[name] is None:
            growth[name] = []
        growth[name].append(record)
    for name, _, identity in COLLECTIONS.values():
        if growth[name] is not None:
            growth[name].sort(key=lambda record: record[identity])
    return {
        "format": "ournotes-growth-snapshot", "schemaVersion": 1,
        "decoderProfile": PROFILE,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "verification": "static_schema_only",
        "complete": False,
        "coverage": {name: "observed" if value is not None else "not_observed"
                     for name, value in growth.items()},
        "growth": growth,
    }


def write_snapshot(path: Path, snapshot: dict):
    """Create a private snapshot without replacing an existing file or symlink."""
    encoded = (json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n').encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("response", type=Path, help="local GetPlayerDataResponse protobuf bytes")
    parser.add_argument("--grpc-frame", action="store_true")
    parser.add_argument("--output", type=Path, required=True, help="new private JSON file; never overwrites")
    args = parser.parse_args(argv)
    try:
        with args.response.open("rb") as stream:
            snapshot = extract_growth(stream.read(MAX_BYTES + 1), grpc_frame=args.grpc_frame)
        write_snapshot(args.output, snapshot)
    except ExportError as error:
        print(f"Export refused: {error}")
        return 2
    except OSError:
        print("Export refused: cannot read input or exclusively create output")
        return 2
    print("Saved a local growth snapshot. Account completeness and level conversion remain unverified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
