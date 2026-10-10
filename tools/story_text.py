"""Strict text-only ADV projection, independent of the legacy media player."""
from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path
from collections.abc import Mapping

LOCALE_FIELDS = {"zh-CN": "_simplifiedChinese", "zh-TW": "_traditionalChinese",
                 "ja": "_japanese", "en": "_english"}
MASTER_TABLES = ("MasterStoryChapter", "MasterStoryEpisode", "MasterStoryFriendshipEpisode",
                 "MasterAdv", "MasterCharacterFriendship", "MasterCharacter", "MasterBand", "MasterText")
# Confirmed from AdvSystem.Asset.AdvCommand in the pinned production metadata.
TEXT_COMMANDS = {2: "dialogue", 20: "location", 28: "subtitle", 37: "chat"}
CONTROL_FLOW_COMMANDS = {40, 41, 42}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(root: Path, name: str) -> list[dict]:
    return json.loads((root / f"{name}.json").read_text(encoding="utf-8"))["_allData"]


def clean_text(value: str) -> str:
    """Strip only Unity formatting tags; output is still escaped by Astro."""
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"</?(?:color|size|b|i|u|s|font|material|align|line-height|voffset|cspace|mspace|indent|link|sprite|ruby|rt)(?:[=\s][^>]*)?>", "", value, flags=re.I)
    return html.unescape(value).replace("\r\n", "\n").strip()


def locale_order(locale: str, fallback_locale=None) -> tuple[str, ...]:
    fallbacks = (fallback_locale,) if isinstance(fallback_locale, str) else tuple(fallback_locale or ())
    return (locale, *(candidate for candidate in fallbacks if candidate != locale))


def story_fallback_locales(region: str, locale: str) -> tuple[str, ...]:
    if region == "jp":
        return ("ja",) if locale != "ja" else ()
    if region == "global":
        priorities = {
            "zh-CN": ("zh-TW", "en", "ja"),
            "zh-TW": ("zh-CN", "en", "ja"),
            "en": ("zh-TW", "zh-CN", "ja"),
            "ja": ("en", "zh-TW", "zh-CN"),
        }
        return priorities[locale]
    return ()


def localized(row: dict, locale: str, fallback_locale=None) -> str:
    for candidate in locale_order(locale, fallback_locale):
        value = clean_text(str(row.get(LOCALE_FIELDS[candidate]) or ""))
        if value:
            return value
    return ""


def parse_document(root: dict, text_rows: list[dict], locale: str, *, fallback_locale=None) -> dict:
    commands = root["Collection"]
    indices = [row["Index"] for row in commands]
    if indices != sorted(indices) or len(indices) != len(set(indices)):
        raise ValueError("ADV command order is ambiguous")
    texts = {row["_id"]: row for row in text_rows}
    if len(texts) != len(text_rows):
        raise ValueError("duplicate ADV text IDs")

    fallback_refs = {}
    def resolve(ref: str) -> str:
        row = texts.get(ref)
        if row is not None:
            for candidate in locale_order(locale, fallback_locale):
                value = localized(row, candidate)
                if value:
                    if candidate != locale: fallback_refs[ref] = candidate
                    return value
        raise ValueError(f"unresolved {locale} ADV text: {ref}")

    # Subtitle commands sometimes omit TargetTextIDs. Reuse only an unambiguous
    # name binding recorded by this script, never infer a person's name from art.
    speakers: dict[str, set[tuple[str, ...]]] = {}
    for command in commands:
        if not command.get("IgnoreData") and command["Command"] in {2, 37}:
            refs = tuple(command.get("TargetTextIDs") or [])
            if refs and command.get("TargetName"):
                speakers.setdefault(command["TargetName"], set()).add(refs)
    lines = []
    skipped = 0
    for command in commands:
        if command.get("IgnoreData"):
            skipped += 1
            continue
        code = command["Command"]
        if code in CONTROL_FLOW_COMMANDS:
            raise ValueError("branching ADV needs an explicit branch reader")
        ref = command.get("AdvTextID")
        if not ref:
            if code == 38:  # ChatStamp: make the missing non-text message visible.
                refs = command.get("TargetTextIDs", [])
                line = {"id": f"line-{command['Index']}", "sourceIndex": command["Index"],
                        "kind": "stamp", "speaker": " / ".join(resolve(r) for r in refs), "text": ""}
                used_locales = sorted({fallback_refs[r] for r in refs if r in fallback_refs})
                if used_locales: line['fallbackLocales'] = used_locales
                lines.append(line)
            continue
        if code == 65:  # ChatTyping previews the next ChatTalk, not another message.
            continue
        if code not in TEXT_COMMANDS:
            raise ValueError(f"unsupported text-bearing ADV command: {code}")
        refs = command.get("TargetTextIDs") or []
        if code == 28 and not refs:
            bindings = speakers.get(command.get("TargetName", ""), set())
            if len(bindings) == 1:
                refs = list(next(iter(bindings)))
        speaker = " / ".join(resolve(r) for r in refs)
        kind = TEXT_COMMANDS[code]
        if kind == "dialogue" and not speaker:
            kind = "narration"
        lines.append({"id": f"line-{command['Index']}", "sourceIndex": command["Index"],
                      "kind": kind, "speaker": speaker, "text": resolve(ref)})
        if ref in fallback_refs: lines[-1]['locale'] = fallback_refs[ref]
        used_locales = sorted({fallback_refs[r] for r in (*refs, ref) if r in fallback_refs})
        if used_locales: lines[-1]['fallbackLocales'] = used_locales
    if not any(line["kind"] in {"dialogue", "chat", "narration", "subtitle"} for line in lines):
        raise ValueError("ADV has no readable body")
    return {"lines": lines, "ignoredCommandCount": skipped,
            **({'fallbackTextCount':len(fallback_refs)} if fallback_refs else {})}


class VerifiedStoryInputs(Mapping):
    """Validate the full inventory, then decode only the requested document."""
    def __init__(self, records):
        self.records = records

    def __len__(self): return len(self.records)
    def __iter__(self): return iter(self.records)

    def __getitem__(self, key):
        path, expected = self.records[key]
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('story document changed after validation')
        return json.loads(raw)

    def __eq__(self, other):
        if not isinstance(other, VerifiedStoryInputs): return NotImplemented
        return self.records == other.records


def read_story_inputs(source: dict, root: Path, *, lazy=False) -> Mapping | None:
    binding = source.get("storyInputs")
    if binding is None:
        return None
    path = root / binding["index"]
    if digest(path) != binding["sha256"]:
        raise ValueError("story input index digest mismatch")
    data = json.loads(path.read_text())
    if data.get("schemaVersion") != 1 or data.get("sourceReleaseId") != source["contentReleaseId"]:
        raise ValueError("story input release mismatch")
    for name in MASTER_TABLES:
        if digest(root / source["masterRoot"] / f"{name}.json") != data["masterSha256"][name]:
            raise ValueError(f"story input Master mismatch: {name}")
    documents = {}
    for row in data["documents"]:
        file = (path.parent / row["path"]).resolve()
        if path.parent.resolve() not in file.parents or digest(file) != row["sha256"]:
            raise ValueError("story document path or digest mismatch")
        key = row["advId"]
        if key in documents:
            raise ValueError("duplicate story document")
        documents[key] = (file, row['sha256']) if lazy else json.loads(file.read_text())
    return VerifiedStoryInputs(documents) if lazy else documents


def project_library(master_root: Path, source_release_id: str, locale: str,
                    documents: dict | None, *, fallback_locale=None) -> tuple[dict, dict]:
    index = {"schemaVersion": 1, "sourceReleaseId": source_release_id, "locale": locale,
             "entries": [], "chapters": [], "characters": [], "bands": []}
    if documents is None:
        return index, {}
    tables = {name: read_rows(master_root, name) for name in MASTER_TABLES}
    texts = {r["_id"]: r for r in tables["MasterText"]}
    text = lambda ref: localized(texts.get(ref, {}), locale, fallback_locale)
    advs = {r["_id"]: r for r in tables["MasterAdv"]}
    chapters = {r["_id"]: r for r in tables["MasterStoryChapter"]}
    friendships = {r["_id"]: r for r in tables["MasterCharacterFriendship"]}
    characters = {r["_id"]: r for r in tables["MasterCharacter"]}
    index["characters"] = [{"id": r["_id"], "name": text(r.get("_nameTextID"))} for r in characters.values()]
    index["bands"] = [{"id": r["_id"], "name": text(r.get("_nameTextID"))} for r in tables["MasterBand"]]
    index["chapters"] = [{"id": r["_id"], "name": text(r["_nameTextId"]), "bandId": r["_bandId"]} for r in chapters.values()]
    projected = {}
    for table in ("MasterStoryEpisode", "MasterStoryFriendshipEpisode"):
        for row in tables[table]:
            friendship = table == "MasterStoryFriendshipEpisode"
            adv = advs[row["_advId"]]
            raw = documents.get(adv["_id"])
            if not raw or raw.get("name") != adv["_advEpisodeAsset"]:
                raise ValueError(f"story document missing or mismatched: {adv['_id']}")
            category = "friendship" if friendship else "viewpoint" if row.get("_isAnotherEpisode") else "band"
            chapter = chapters.get(row.get("_chapterId"), {})
            pair = friendships.get(row.get("_characterFriendshipId"), {})
            character_ids = ([pair["_masterCharacterIdA"], pair["_masterCharacterIdB"]] if friendship
                             else [row["_characterId"]] if row.get("_characterId") else chapter.get("_mainCharacterIds", []))
            band_ids = sorted({characters[c]["_bandID"] for c in character_ids})
            group = f"friendship-{pair['_id']}" if friendship else f"{category}-{chapter['_id']}"
            identifier = f"story-entry-{'friendship' if friendship else 'main'}-{row['_id']}"
            document = parse_document(raw["root"], raw["texts"], locale, fallback_locale=fallback_locale)
            projected[identifier] = {"schemaVersion": 1, "sourceReleaseId": source_release_id,
                                     "locale": locale, "id": identifier, "lines": document["lines"]}
            entry = {"id": identifier, "category": category, "title": text(adv["_titleTextId"]),
                     "description": text(row.get("_descriptionTextId")), "chapterId": chapter.get("_id"),
                     "chapterName": text(chapter.get("_nameTextId")), "characterIds": character_ids,
                     "bandIds": band_ids, "group": group, "episodeNumber": row["_episodeNumber"],
                     "isExtra": bool(row.get("_isExtraEpisode")), "friendshipLevel": row.get("_unlockCharacterFriendshipLevel", 0),
                     "lineCount": sum(l["kind"] in {"dialogue", "chat", "narration", "subtitle"} for l in document["lines"]),
                     "previousId": None, "nextId": None}
            from tools.library_metadata import story_identity
            entry['contentIdentity'] = story_identity(entry, document['lines'])
            if document.get('fallbackTextCount'): entry['fallbackTextCount'] = document['fallbackTextCount']
            index["entries"].append(entry)
    if len(projected) != len(documents):
        raise ValueError("story input contains documents outside the three supported categories")
    index["entries"].sort(key=lambda r: (r["category"], r["group"], r["episodeNumber"], r["id"]))
    groups = {}
    for entry in index["entries"]:
        groups.setdefault(entry["group"], []).append(entry)
    for entries in groups.values():
        for i, entry in enumerate(entries):
            entry["previousId"] = entries[i - 1]["id"] if i else None
            entry["nextId"] = entries[i + 1]["id"] if i + 1 < len(entries) else None
    return index, projected
