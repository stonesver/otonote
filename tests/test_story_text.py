from __future__ import annotations
import json
import tempfile
import unittest
from pathlib import Path
from tools.story_text import parse_document, clean_text, read_story_inputs, project_library, digest, MASTER_TABLES, story_fallback_locales
from tools.site_product import closed_data


def command(index, code=2, ref="line", speakers=None, **extra):
    return {"Index": index, "Command": code, "AdvTextID": ref,
            "TargetTextIDs": ["speaker"] if speakers is None else speakers,
            "TargetName": "tomori", **extra}


class StoryTextTests(unittest.TestCase):
    def setUp(self):
        self.texts = [{"_id": "line", "_simplifiedChinese": "第一行\n第二行", "_english": "Hello"},
                      {"_id": "speaker", "_simplifiedChinese": "灯", "_english": "Tomori"}]

    def parse(self, commands, locale="zh-CN"):
        return parse_document({"Collection": commands}, self.texts, locale)

    def test_ignored_unresolved_commands_and_chat_typing_are_not_dialogue(self):
        result = self.parse([command(0, ref="deleted", IgnoreData=1), command(1, 65), command(2, 37)])
        self.assertEqual(result["ignoredCommandCount"], 1)
        self.assertEqual(len(result["lines"]), 1)
        self.assertEqual(result["lines"][0]["kind"], "chat")
        self.assertEqual(result["lines"][0]["sourceIndex"], 2)

    def test_locale_order_speakers_narration_and_subtitles(self):
        result = self.parse([command(0), command(1, 28, speakers=[]), command(2, speakers=[])], "en")
        self.assertEqual([r["speaker"] for r in result["lines"]], ["Tomori", "Tomori", ""])
        self.assertEqual([r["kind"] for r in result["lines"]], ["dialogue", "subtitle", "narration"])
        self.assertTrue(all(r["text"] == "Hello" for r in result["lines"]))

    def test_multiple_speakers_and_stickers_are_preserved(self):
        self.texts.append({"_id": "anon", "_simplifiedChinese": "爱音"})
        result = self.parse([command(0, speakers=["speaker", "anon"]), command(1, 38, ref="")])
        self.assertEqual(result["lines"][0]["speaker"], "灯 / 爱音")
        self.assertEqual(result["lines"][1]["kind"], "stamp")

    def test_missing_text_locale_and_unknown_text_commands_fail(self):
        for commands, locale in [([command(0, ref="missing")], "en"), ([command(0)], "ja"),
                                 ([command(0, 99)], "en"), ([command(0), command(1, 42, ref="")], "en"),
                                 ([command(2), command(1)], "en"), ([command(0), command(0)], "en")]:
            with self.subTest(commands=commands, locale=locale), self.assertRaises(ValueError):
                self.parse(commands, locale)

    def test_jp_fallback_is_explicit_and_never_hides_missing_source_text(self):
        rows=[{"_id":"line","_japanese":"こんにちは"},{"_id":"speaker","_japanese":"灯"}]
        root={"Collection":[command(0)]}
        with self.assertRaises(ValueError):parse_document(root,rows,"en")
        result=parse_document(root,rows,"en",fallback_locale="ja")
        self.assertEqual(result["lines"][0]["text"],"こんにちは")
        self.assertEqual(result["lines"][0]["locale"],"ja")
        self.assertEqual(result["fallbackTextCount"],2)
        with self.assertRaises(ValueError):parse_document(root,rows[:1],"en",fallback_locale="ja")

    def test_global_simplified_chinese_uses_only_available_official_text(self):
        self.assertEqual(story_fallback_locales('global', 'zh-CN'), ('zh-TW', 'en', 'ja'))
        self.assertEqual(story_fallback_locales('global', 'en'), ('zh-TW', 'zh-CN', 'ja'))
        rows = [{"_id": "line", "_traditionalChinese": "繁體原文",
                 "_english": "English original", "_japanese": "日本語原文"},
                {"_id": "speaker", "_simplifiedChinese": "灯"}]
        root = {"Collection": [command(0)]}
        fallbacks = story_fallback_locales('global', 'zh-CN')
        for field, text, locale in (("_traditionalChinese", "繁體原文", "zh-TW"),
                                    ("_english", "English original", "en"),
                                    ("_japanese", "日本語原文", "ja")):
            result = parse_document(root, rows, 'zh-CN', fallback_locale=fallbacks)
            self.assertEqual(result['lines'][0]['text'], text)
            self.assertEqual(result['lines'][0]['locale'], locale)
            self.assertEqual(result['lines'][0]['fallbackLocales'], [locale])
            self.assertEqual(result['fallbackTextCount'], 1)
            rows[0].pop(field)
        with self.assertRaisesRegex(ValueError, 'unresolved zh-CN ADV text: line'):
            parse_document(root, rows, 'zh-CN', fallback_locale=fallbacks)

    def test_fallback_speaker_is_marked_even_when_body_is_translated(self):
        rows = [{"_id": "line", "_simplifiedChinese": "简中对白"},
                {"_id": "speaker", "_traditionalChinese": "繁中角色名"}]
        result = parse_document({"Collection": [command(0)]}, rows, 'zh-CN',
                                fallback_locale=story_fallback_locales('global', 'zh-CN'))
        line = result['lines'][0]
        self.assertEqual(line['text'], '简中对白')
        self.assertEqual(line['speaker'], '繁中角色名')
        self.assertNotIn('locale', line)
        self.assertEqual(line['fallbackLocales'], ['zh-TW'])
        self.assertEqual(result['fallbackTextCount'], 1)

    def test_unity_markup_and_line_breaks(self):
        self.assertEqual(clean_text('<color=#fff>Hello</color><br>world &amp; friends'), 'Hello\nworld & friends')
        self.assertEqual(clean_text('A < B > C'), 'A < B > C')

    def test_story_artifacts_survive_v1_media_pruning(self):
        self.assertFalse(closed_data('story-library.json'))
        self.assertFalse(closed_data('story-text'))
        self.assertTrue(closed_data('story-resources.json'))

    def test_unbound_region_stays_empty(self):
        index, documents = project_library(Path('/does-not-exist'), 'jp-release', 'ja', None)
        self.assertEqual(index['entries'], [])
        self.assertEqual(documents, {})

    def test_binding_checks_release_master_document_hash_and_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            master = root / 'master'; master.mkdir()
            for name in MASTER_TABLES:
                (master / f'{name}.json').write_text('{"_allData":[]}')
            (root / 'story.json').write_text('{}')
            index = {'schemaVersion': 1, 'sourceReleaseId': 'release',
                     'masterSha256': {n: digest(master / f'{n}.json') for n in MASTER_TABLES},
                     'documents': [{'advId': 1, 'path': 'story.json', 'sha256': digest(root / 'story.json')}]}
            path = root / 'index.json'; path.write_text(json.dumps(index))
            source = {'contentReleaseId': 'release', 'masterRoot': 'master',
                      'storyInputs': {'index': 'index.json', 'sha256': digest(path)}}
            self.assertEqual(read_story_inputs(source, root), {1: {}})
            lazy = read_story_inputs(source, root, lazy=True)
            self.assertEqual(len(lazy), 1)
            self.assertEqual(lazy[1], {})
            self.assertEqual(lazy, read_story_inputs(source, root, lazy=True))
            with self.assertRaises(ValueError):
                read_story_inputs({**source, 'contentReleaseId': 'another'}, root)
            (root / 'story.json').write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, 'changed after validation'):
                lazy[1]
            with self.assertRaises(ValueError):
                read_story_inputs(source, root)

    def test_categories_names_and_adjacency_do_not_mix_viewpoints_or_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            texts = [{'_id': key, '_english': value} for key, value in
                     [('band', 'MyGO!!!!!'), ('chapter', 'Beginning'), ('char1', 'Tomori'),
                      ('char2', 'Anon'), ('char3', 'Rana'), ('title', 'The next day')]]
            tables = {name: [] for name in MASTER_TABLES}
            tables.update(MasterText=texts,
                MasterCharacter=[{'_id': i, '_nameTextID': f'char{i}', '_bandID': 1} for i in range(1, 4)],
                MasterBand=[{'_id': 1, '_nameTextID': 'band'}],
                MasterStoryChapter=[{'_id': 1, '_nameTextId': 'chapter', '_bandId': 1, '_mainCharacterIds': [1, 2, 3]}],
                MasterCharacterFriendship=[{'_id': 102, '_masterCharacterIdA': 1, '_masterCharacterIdB': 2},
                                           {'_id': 103, '_masterCharacterIdA': 1, '_masterCharacterIdB': 3}],
                MasterStoryEpisode=[{'_id': i, '_advId': i, '_chapterId': 1, '_episodeNumber': i,
                                     '_isAnotherEpisode': i == 2, '_isExtraEpisode': i == 3, '_characterId': 1 if i == 2 else 0}
                                    for i in range(1, 4)],
                MasterStoryFriendshipEpisode=[{'_id': i, '_advId': i, '_characterFriendshipId': 102 if i == 4 else 103, '_episodeNumber': 1}
                                             for i in [4, 5]],
                MasterAdv=[{'_id': i, '_advEpisodeAsset': f'adv_{i}', '_titleTextId': 'title'} for i in range(1, 6)])
            for name, rows in tables.items():
                (root / f'{name}.json').write_text(json.dumps({'_allData': rows}))
            docs = {i: {'name': f'adv_{i}', 'root': {'Collection': [command(0)]}, 'texts': self.texts} for i in range(1, 6)}
            index, bodies = project_library(root, 'release', 'en', docs)
            entries = {r['id']: r for r in index['entries']}
            first = entries['story-entry-main-1']
            self.assertEqual(first['nextId'], 'story-entry-main-3')
            self.assertTrue(entries['story-entry-main-3']['isExtra'])
            self.assertEqual(entries['story-entry-main-2']['category'], 'viewpoint')
            self.assertIsNone(entries['story-entry-main-2']['previousId'])
            self.assertIsNone(entries['story-entry-friendship-4']['nextId'])
            self.assertEqual(index['characters'][0]['name'], 'Tomori')
            self.assertEqual(index['bands'][0]['name'], 'MyGO!!!!!')
            self.assertEqual(len(bodies), 5)


if __name__ == '__main__':
    unittest.main()
