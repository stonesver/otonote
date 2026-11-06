import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getRuntimeUiLabels,
  runtimeUiLabels
} from "../src/lib/runtime-ui-labels.ts";

const hasHan = (value) => /\p{Script=Han}/u.test(value);

const shape = (value) => {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, shape(child)])
    );
  }
  return typeof value;
};

test("runtime label locales have the same typed interface and English has no Han UI", () => {
  assert.deepEqual(shape(runtimeUiLabels.en), shape(runtimeUiLabels["zh-CN"]));
  const englishStrings = JSON.stringify(runtimeUiLabels.en);
  assert.equal(hasHan(englishStrings), false);
  assert.equal(getRuntimeUiLabels("en"), runtimeUiLabels.en);
  assert.equal(getRuntimeUiLabels("ja"), runtimeUiLabels["zh-CN"]);
});

test("runtime owners consume labels instead of hard-coded Chinese UI", async () => {
  const paths = [
    "../src/lib/team-draft-workbench.mjs",
    "../src/lib/scoring-research-workbench.mjs",
    "../src/lib/performance-input.mjs",
    "../src/lib/score-workbench-element.ts",
    "../src/lib/score-workbench-renderer.ts"
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.equal(hasHan(source), false, `${path} contains dynamic Chinese UI`);
    assert.match(source, /labels/);
  }


});

test("dynamic owners explicitly mark entity-data ownership boundaries", async () => {
  const paths = [
    "../src/lib/preset-portfolio-ui.mjs",
    "../src/lib/scoring-research-workbench.mjs"
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /uiEntity|data-ui-entity/, `${path} must preserve entity text`);
  }
});
