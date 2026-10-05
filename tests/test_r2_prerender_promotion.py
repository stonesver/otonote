"""Serving-pointer boundaries for staged Global and JP R2 prerenders."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from deploy import promote_r2_prerender as promotion


CODE_ID = "e" * 24
PAIRS = {"global": "a" * 24 + "-" + "b" * 24,
         "jp": "c" * 24 + "-" + "d" * 24}
OLD = {"current": "releases/" + "1" * 24 + "-" + "2" * 24,
       "current-jp": "releases/" + "3" * 24 + "-" + "4" * 24,
       "previous": "releases/" + "5" * 24 + "-" + "6" * 24,
       "previous-jp": "releases/" + "7" * 24 + "-" + "8" * 24}


def pointer(region):
    return {"edition": region, "contentReleaseId": PAIRS[region]}


def source_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class PromotionFixture:
    def __init__(self, root):
        self.code = root / "code"
        self.content = root / "content"
        self.rendered = root / "rendered"
        self.stage = self.rendered / ".r2-stage-test"
        for directory in (self.code, self.content / "jp", self.stage,
                          self.rendered / "releases"):
            directory.mkdir(parents=True)
        (self.code / "sentinel.txt").write_text("sealed code")
        (self.content / "current.json").write_text(json.dumps(pointer("global")))
        (self.content / "jp/current.json").write_text(json.dumps(pointer("jp")))
        for name, target in OLD.items():
            (self.rendered / target).mkdir(exist_ok=True)
            (self.rendered / name).symlink_to(target)
        for region, suffix in (("global", ""), ("jp", "-jp")):
            pair = PAIRS[region]
            release = self.stage / "releases" / pair
            (release / region).mkdir(parents=True)
            (release / "complete.json").write_text(json.dumps({
                "schemaVersion": 1, "pair": pair, "codeId": CODE_ID,
                "region": region, "pointer": pointer(region),
            }))
            (self.stage / ("current" + suffix)).symlink_to("releases/" + pair)

    def read_inputs(self, _code, _content, region):
        return None, {"codeId": CODE_ID}, json.dumps(pointer(region)).encode(), PAIRS[region]

    def live_links(self):
        return {name: (self.rendered / name).readlink().as_posix() for name in OLD}

    def promote(self):
        return promotion.promote(self.code, self.content, self.stage, self.rendered)


class R2PrerenderPromotionTests(unittest.TestCase):
    def test_both_regions_promote_only_after_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            before_code = source_bytes(fixture.code)
            before_content = source_bytes(fixture.content)
            with patch.object(promotion, "read_inputs", side_effect=fixture.read_inputs):
                result = fixture.promote()
            self.assertEqual(result, {region: "releases/" + pair for region, pair in PAIRS.items()})
            self.assertEqual(fixture.live_links(), {
                "current": result["global"], "current-jp": result["jp"],
                "previous": OLD["current"], "previous-jp": OLD["current-jp"],
            })
            for region, pair in PAIRS.items():
                self.assertTrue((fixture.rendered / "releases" / pair / region).is_dir())
            self.assertEqual(source_bytes(fixture.code), before_code)
            self.assertEqual(source_bytes(fixture.content), before_content)

    def test_missing_or_mismatched_jp_stage_keeps_every_live_link(self):
        for invalid in ("missing", "mismatched"):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as temporary:
                fixture = PromotionFixture(Path(temporary))
                if invalid == "missing":
                    (fixture.stage / "current-jp").unlink()
                else:
                    complete_path = fixture.stage / "releases" / PAIRS["jp"] / "complete.json"
                    complete = json.loads(complete_path.read_text())
                    complete["pointer"] = {"edition": "wrong"}
                    complete_path.write_text(json.dumps(complete))
                before_code = source_bytes(fixture.code)
                before_content = source_bytes(fixture.content)
                with patch.object(promotion, "read_inputs", side_effect=fixture.read_inputs):
                    with self.assertRaises(ValueError):
                        fixture.promote()
                self.assertEqual(fixture.live_links(), OLD)
                self.assertFalse((fixture.rendered / "releases" / PAIRS["global"]).exists())
                self.assertEqual(source_bytes(fixture.code), before_code)
                self.assertEqual(source_bytes(fixture.content), before_content)

    def test_second_region_switch_failure_restores_current_and_previous_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            before_code = source_bytes(fixture.code)
            before_content = source_bytes(fixture.content)
            real_switch = promotion._switch
            injected = False

            def fail_once(root, name, target):
                nonlocal injected
                if name == "current-jp" and not injected:
                    injected = True
                    raise OSError("injected JP switch failure")
                return real_switch(root, name, target)

            with patch.object(promotion, "read_inputs", side_effect=fixture.read_inputs), \
                    patch.object(promotion, "_switch", side_effect=fail_once):
                with self.assertRaisesRegex(OSError, "injected JP switch failure"):
                    fixture.promote()
            self.assertTrue(injected)
            self.assertEqual(fixture.live_links(), OLD)
            self.assertEqual(source_bytes(fixture.code), before_code)
            self.assertEqual(source_bytes(fixture.content), before_content)


if __name__ == "__main__":
    unittest.main()
