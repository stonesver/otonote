import test from "node:test";
import assert from "node:assert/strict";
import { classifySceneBreak, formatStoryLineText, groupStoryBlocks } from "../src/lib/story-text-format.mjs";

test("classifySceneBreak distinguishes time jumps from location changes", () => {
  assert.equal(classifySceneBreak("10分钟后"), "time");
  assert.equal(classifySceneBreak("1週間後"), "time");
  assert.equal(classifySceneBreak("20話 ライブから数日後"), "time");
  assert.equal(classifySceneBreak("ある日の練習前"), "time");
  assert.equal(classifySceneBreak("次日"), "time");
  assert.equal(classifySceneBreak("羽丘女子学园 中庭"), "location");
  assert.equal(classifySceneBreak("RiNG 休息室"), "location");
  assert.equal(classifySceneBreak("Live House 舞台侧台"), "location");
});

test("formatStoryLineText joins mid-clause ADV dialog wraps while preserving sentence breaks and subtitles", () => {
  assert.equal(
    formatStoryLineText("从今以后我们就是一支乐队，\n也就是共同演奏音乐的伙伴", "dialogue"),
    "从今以后我们就是一支乐队，也就是共同演奏音乐的伙伴",
  );
  assert.equal(
    formatStoryLineText("小祥！太好了～你终于来了！\n你全身都湿透了！没事吧！？", "dialogue"),
    "小祥！太好了～你终于来了！\n你全身都湿透了！没事吧！？",
  );
  assert.equal(formatStoryLineText("Hello\nworld!", "dialogue"), "Hello world!");
  assert.equal(formatStoryLineText("第一行歌词\n第二行歌词", "subtitle"), "第一行歌词\n第二行歌词");
});

test("groupStoryBlocks groups chat/stamp into chat-stage and consecutive subtitles into subtitle-stage", () => {
  const blocks = groupStoryBlocks([
    { id: "1", kind: "dialogue", speaker: "灯", text: "a" },
    { id: "2", kind: "dialogue", speaker: "灯", text: "b" },
    { id: "3", kind: "chat", speaker: "爱音", text: "hi" },
    { id: "4", kind: "stamp", speaker: "爱音", text: "" },
    { id: "5", kind: "chat", speaker: "爽世", text: "ok" },
    { id: "6", kind: "subtitle", speaker: "灯", text: "line 1" },
    { id: "7", kind: "subtitle", speaker: "灯", text: "line 2" },
    { id: "8", kind: "location", speaker: "", text: "10分钟后" },
  ]);
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].type, "line");
  assert.equal(blocks[1].item.isContinuation, true);
  assert.equal(blocks[2].type, "chat-stage");
  assert.equal(blocks[2].items.length, 3);
  assert.equal(blocks[2].items[0].chatSide, "left");
  assert.equal(blocks[2].items[2].chatSide, "right");
  assert.equal(blocks[3].type, "subtitle-stage");
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[3].items[1].isContinuation, true);
  assert.equal(blocks[4].item.sceneKind, "time");
});
