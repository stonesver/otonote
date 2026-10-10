import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemberCardDetailModel } from "../src/lib/member-card-detail-model.mjs";
import { createSupportCardDetailModel } from "../src/lib/support-card-detail-model.mjs";

const readSource = (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

const p0Pages = [
  "../src/pages/index.astro",
  "../src/pages/catalog/index.astro",
  "../src/pages/cards/index.astro",
  "../src/pages/music/index.astro",
  "../src/pages/database/index.astro",
  "../src/pages/tools/index.astro",
  "../src/pages/tools/deck-builder/index.astro",
  "../src/pages/tools/song-calculator/index.astro",
  "../src/pages/tools/optimizer/index.astro",
];

test("technical source notes use one native disclosure boundary", async () => {
  const source = await readSource("../src/components/SourceDisclosure.astro");

  assert.match(source, /<details\b/);
  assert.match(source, /data-copy-layer="technical"/);
  assert.match(source, /<summary\b/);
  assert.match(source, /sourceAndLimits/);
});

test("P0 pages provide task headings and keep calculation notes in disclosures", async () => {
  for (const path of p0Pages) {
    const source = await readSource(path);
    if (path.endsWith("/optimizer/index.astro")) {
      assert.match(source, /Astro\.redirect\(destination \+ Astro\.url\.search \+ Astro\.url\.hash, 301\)/);
      continue;
    }
    assert.match(source, /<h1\b|<ToolPageHeader\b/, `${path} has no visitor task heading`);
    if (source.includes("<SourceDisclosure")) {
      assert.ok(source.indexOf("<SourceDisclosure") > Math.max(source.indexOf("<h1"), source.indexOf("<ToolPageHeader")), `${path} puts source notes before its task heading`);
    }
  }
  const header = await readSource("../src/components/ToolPageHeader.astro");
  assert.match(header, /data-copy-layer="primary"/);
  assert.match(header, /<h1[\s\S]*?\{title\}[\s\S]*?<p>\{description\}/);
  for (const component of ["TeamDraftWorkbench", "ScoringResearchWorkbench"]) {
    const source = await readSource(`../src/components/${component}.astro`);
    assert.match(source, /<ScoringModelNotice\s*\/>/, `${component} lacks model assumptions`);
  }
});

test("tool hero copy does not lead with implementation jargon", async () => {
  const paths = [
    "../src/pages/tools/index.astro",
    "../src/pages/tools/deck-builder/index.astro",
    "../src/pages/tools/song-calculator/index.astro",
    "../src/pages/tools/optimizer/index.astro",
  ];
  for (const path of paths) {
    const source = await readSource(path);
    const primary = source.match(/data-copy-layer="primary"[\s\S]*?<\/section>/)?.[0] ?? "";
    const visibleCopy = primary.replace(/<[^>]*>/g, " ").replace(/\{[^}]*}/g, " ");
    assert.doesNotMatch(visibleCopy, /\b(?:Gate|Release|Master|ScoringEngine|Profile|fixture|Worker|build artifact)\b/i, path);
  }
});

test("score estimates disclose scope", async () => {
  const calculator = await readSource("../src/pages/tools/song-calculator/index.astro");
  const optimizer = await readSource("../src/pages/tools/optimizer/index.astro");
  const builder = await readSource("../src/pages/tools/deck-builder/index.astro");
  const notice = await readSource("../src/components/ScoringModelNotice.astro");
  const workbench = await readSource("../src/components/ScoringResearchWorkbench.astro");
  assert.match(calculator, /<SourceDisclosure>/);
  assert.match(calculator, /默认按全部音符获得 Perfect、满生命且不开启辅助/);
  assert.match(calculator, /技能发动顺序会影响分数/);
  assert.match(calculator, /尚不能保证与游戏实得分数完全一致/);
  assert.match(calculator, /规则尚未确认的活动暂不支持计算/);
  assert.match(notice, /实际分数会受判定与技能顺序影响/);
  assert.match(workbench, /模板是可编辑的模拟输入，不是实战记录/);
  assert.match(workbench, /LUCK 为概率抽样，最低／最高分是样本范围/);
  assert.match(optimizer, /\/tools\/deck-builder\//);
  assert.match(optimizer, /Astro\.url\.search \+ Astro\.url\.hash, 301/);
  assert.match(builder, /<TeamDraftWorkbench/);
});

test("source disclosures stay compact, keyboard-visible, and mobile-safe", async () => {
  const css = await readSource("../src/styles/global.css");
  assert.match(css, /\.source-disclosure\s*\{/);
  assert.match(css, /\.source-disclosure\s*>\s*summary:focus-visible/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*\.source-disclosure/);
});

test("home leads with visitor tasks instead of release-process labels", async () => {
  const source = await readSource("../src/pages/index.astro");

  assert.doesNotMatch(source, /VISUAL EVIDENCE|STAGING|PACKAGE|CATALOG NOTE/);
  for (const route of ["/catalog/", "/music/", "/tools/deck-builder/"]) {
    assert.ok(source.includes(`href: "${route}"`));
  }
  assert.match(source, /资料|卡牌/);
});

test("catalog and card entrances explain how visitors can browse and equip", async () => {
  const catalog = await readSource("../src/pages/catalog/index.astro");
  const cards = await readSource("../src/pages/cards/index.astro");

  for (const route of ["/characters/", "/cards/members/", "/cards/supports/"]) {
    assert.ok(catalog.includes(`route: "${route}"`), `catalog lacks ${route}`);
  }
  assert.match(catalog, /collections\.map\(entry => <a/);
  assert.match(catalog, /角色与卡牌/);
  assert.match(cards, /成员卡用于乐队编成/);
  assert.match(cards, /留影用于装备/);
  assert.match(cards, /登场角色不代表装备限制/);
});

test("member card details make formation the primary action", async () => {
  const detail = createMemberCardDetailModel({
    cardId: "member-card-1",
    skillSummaries: [{ skillId: "skill-1", name: "主技能", summary: "效果" }],
    resolveSkill: () => ({ id: "skill-1", kind: "live" })
  });

  assert.deepEqual(
    detail.primaryAction,
    {
      logicalPath: "/tools/deck-builder/?member=member-card-1",
      label: "加入编成"
    }
  );
});

test("member cards without skill projections can still join a formation", () => {
  const detail = createMemberCardDetailModel({
    cardId: "member-card-without-skills",
    skillSummaries: [],
    resolveSkill: () => undefined
  });

  assert.deepEqual(
    detail.primaryAction,
    {
      logicalPath: "/tools/deck-builder/?member=member-card-without-skills",
      label: "加入编成"
    }
  );
});

test("support details separate both effects and keep deep topics beside the image", () => {
  const detail = createSupportCardDetailModel({
    cardId: "support-card-1",
    skillSummaries: [
      { slot: "support_1", skillId: "support-skill-23", summary: "普通效果" },
      { slot: "gekisou_support_1", skillId: "gekisou-support-skill-22", summary: "激奏效果" }
    ]
  });

  assert.deepEqual(
    {
      aspectRatio: detail.aspectRatio,
      normalEffect: detail.normalEffect?.summary,
      gekisouEffect: detail.gekisouEffect?.summary,
      primaryAction: detail.primaryAction,
      imageSidebarTopics: detail.imageSidebarTopics.map((topic) => topic.id),
      gekisouLogicalPath: detail.imageSidebarTopics.find(
        (topic) => topic.id === "gekisou"
      )?.logicalPath
    },
    {
      aspectRatio: "16:9",
      normalEffect: "普通效果",
      gekisouEffect: "激奏效果",
      primaryAction: {
        logicalPath: "/tools/deck-builder/?support=support-card-1",
        label: "装备到编成"
      },
      imageSidebarTopics: ["growth", "materials", "resources"],
      gekisouLogicalPath: undefined
    }
  );
});

test("card details share growth previews and grouped skills with small artwork actions", async () => {
  const archive = await readSource("../src/components/card-details/CardDetailArchive.astro");
  for (const kind of ["Member", "Support"]) {
    const wrapper = await readSource(`../src/components/card-details/${kind}CardDetail.astro`);
    assert.match(wrapper, /<CardDetailArchive/);
    assert.doesNotMatch(wrapper, /slot="priority"/);
  }
  assert.match(archive, /data-growth-power="total"/);
  assert.match(archive, /class="card-unified-skills"/);
  assert.match(archive, /class="card-info-actions"/);
  assert.match(archive, /class="card-art-download"/);
  assert.match(archive, /data-panel="materials"/);
  assert.doesNotMatch(archive, /data-panel="resources"|gekisou-lab|member-card-primary-skill/);
});

test("music and story entrances describe available content and preserve category navigation", async () => {
  const music = await readSource("../src/pages/music/index.astro");
  const stories = await readSource("../src/pages/stories/index.astro");
  const storyCategory = await readSource("../src/components/StoryCategory.astro");

  for (const term of ["演唱", "BPM", "难度", "谱面结构"]) {
    assert.match(music, new RegExp(term));
  }
  assert.match(music, /播放已收录的歌曲音频/);
  assert.match(music, /音频是否可播放以各曲目页面为准/);
  assert.match(music, /谱面预览效果可能与实际演奏有所不同/);
  assert.match(stories, /Astro\.redirect\([\s\S]*?, 301\)/);
  assert.match(stories, /\['main','extra','viewpoint','friendship','event'\]/);
  assert.match(stories, /new URLSearchParams\(Astro\.url\.search\)/);
  assert.match(storyCategory, /data-story-library/);
  assert.match(storyCategory, /copy.unavailable/);
});

test("database entrances describe visitor-visible content", async () => {
  const database = await readSource("../src/pages/database/index.astro");
  assert.match(database, /查找技能、道具和乐队强化/);
  assert.match(database, /从卡牌反查/);
  for (const route of ["/database/skills/", "/database/items/", "/database/band-items/"]) {
    assert.ok(database.includes(`href="${route}"`), `database lacks ${route}`);
  }
});

test("tools directory exposes score estimates and pairing without an obsolete pending entry", async () => {
  const page = await readSource("../src/pages/tools/index.astro");
  const toolPaths = [...page.matchAll(/\{path:'([^/][^']*)',mark:/g)].map((match) => match[1]);
  const renderedToolIndexes = [...(page.match(/\{\[items\[\d+\][^\n]+\.map\(item/)?.[0] ?? "").matchAll(/items\[(\d+)\]/g)]
    .map((match) => Number(match[1]));
  assert.deepEqual(toolPaths.toSorted(), ["gacha-history", "live2d", "deck-builder", "song-ranking", "song-calculator", "ap-grade", "event-efficiency"].toSorted());
  assert.deepEqual(renderedToolIndexes.toSorted((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.match(page, /href=\{href\(`\/tools\/\$\{item.path\}\/`\)\}/);
  assert.deepEqual([...page.matchAll(/\{path:'(\/[^']*)',kind:/g)].map((match) => match[1]), ["/music/", "/stories/"]);

  assert.deepEqual(
    {
      readyActionTemplate: (page.match(/<a[^>]+data-tool-state="available"/g) ?? []).length,
      pendingActions: (page.match(/<a[^>]+data-tool-state="pending"/g) ?? []).length,
      pendingRows: (page.match(/<div[^>]+data-tool-state="pending"/g) ?? []).length,
      directHeading: page.includes("<h1>") && !page.includes("page-stamp"),
      noLegacyGrid: !page.includes("tool-module-grid"),
      notesAfterTools: page.indexOf('<footer class="tools-desk-note">') > page.lastIndexOf("</nav>"),
      estimateScope: page.includes("实际表现受判定与技能顺序影响")
    },
    {
      readyActionTemplate: 1,
      pendingActions: 0,
      pendingRows: 0,
      directHeading: true,
      noLegacyGrid: true,
      notesAfterTools: true,
      estimateScope: true
    }
  );
});
