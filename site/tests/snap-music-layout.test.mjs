import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

test("uses the game-facing Snap name while preserving support routes", async () => {
  const [directory, detail, switchData] = await Promise.all([
    readSource("../src/pages/cards/supports/index.astro"),
    readSource("../src/pages/cards/supports/[id].astro"),
    readSource("../src/lib/detail-switch-data.ts")
  ]);

  for (const source of [directory, detail, switchData]) {
    assert.doesNotMatch(source, /支援卡|Support Card/);
  }
  assert.match(directory, /留影/);
  assert.match(detail, /label=\{supportCardSwitchData\.label\}/);
  assert.match(switchData, /label: "留影"/);
  assert.match(switchData, /\/cards\/supports\//);
});

test("card entry and directories keep distinct compact player decisions", async () => {
  const [landing, memberPage, supportPage, memberTile, supportTile] = await Promise.all([
    readSource("../src/pages/cards/index.astro"),
    readSource("../src/pages/cards/members/index.astro"),
    readSource("../src/pages/cards/supports/index.astro"),
    readSource("../src/components/MemberCardTile.astro"),
    readSource("../src/components/SupportCardTile.astro")
  ]);

  assert.deepEqual(
    {
      landingPurposes: [...landing.matchAll(/data-card-purpose="([^"]+)"/g)]
        .map((match) => match[1]),
      landingImagePreviews: (landing.match(/<ImageStage/g) ?? []).length,
      sharedDirectoryBrowsers: [memberPage, supportPage]
        .filter((source) => source.includes("<CatalogBrowser")).length,
      member: {
        kind: memberTile.includes('data-card-kind="member"'),
        ratio: memberTile.includes('data-media-ratio="3:4"'),
        character: memberTile.includes("character?.displayName"),
        band: memberTile.includes("band?.displayName"),
        rarity: memberTile.includes("<CardRarityBadge"),
        attribute: memberTile.includes("<CardAttributeBadge")
      },
      support: {
        kind: supportTile.includes('data-card-kind="support"'),
        ratio: supportTile.includes('data-media-ratio="16:9"'),
        featuredRelations: supportTile.includes("characterNames || ui.relationPending"),
        rarity: supportTile.includes("<CardRarityBadge"),
        attribute: supportTile.includes("<CardAttributeBadge")
      }
    },
    {
      landingPurposes: ["formation", "equipment"],
      landingImagePreviews: 0,
      sharedDirectoryBrowsers: 2,
      member: {
        kind: true,
        ratio: true,
        character: true,
        band: true,
        rarity: true,
        attribute: true
      },
      support: {
        kind: true,
        ratio: true,
        featuredRelations: true,
        rarity: true,
        attribute: true
      }
    }
  );
});

test("declares ratio-aware dense media and a sticky detail switcher", async () => {
  const [facetedBrowserCss, musicArchiveCss, detailSwitcherCss, cardCss] = await Promise.all([
    readSource("../src/styles/faceted-browser.css"),
    readSource("../src/styles/music-archive.css"),
    readSource("../src/styles/detail-switcher.css"),
    readSource("../src/styles/card-artwork.css")
  ]);

  assert.match(
    facetedBrowserCss,
    /\.catalog-tile\.support-card-tile \.tile-media\s*\{[^}]*width:\s*88px;[^}]*height:\s*50px;[^}]*aspect-ratio:\s*16\s*\/\s*9/s
  );
  assert.match(
    facetedBrowserCss,
    /\.catalog-tile\.compact-catalog-tile\s*\{[^}]*max-width:\s*none;[^}]*min-height:\s*66px/s
  );
  assert.match(
    facetedBrowserCss,
    /\.catalog-grid\.card-catalog-grid,[\s\S]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(188px,\s*1fr\)\)/s
  );
  assert.match(
    facetedBrowserCss,
    /\.catalog-tile\.compact-catalog-tile\s*\{[^}]*max-width:\s*none;/s
  );
  assert.match(
    musicArchiveCss,
    /\.music-jacket\s*\{[^}]*aspect-ratio:\s*1/s
  );
  assert.match(
    detailSwitcherCss,
    /\.detail-switcher\s*\{[^}]*position:\s*sticky[^}]*top:/s
  );
  assert.match(
    cardCss,
    /\.card-artwork-front\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/s
  );
  assert.match(
    cardCss,
    /\.card-artwork--support \.card-artwork-front\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10/s
  );
});

test("projects per-track score and four-stage difficulty rewards", async () => {
  const catalog = JSON.parse(
    await readSource("../src/data/generated/catalog.json")
  );
  const rewards = catalog.musicTracks[0].soloRewards;

  assert.equal(rewards.scoreRewards.length, 5);
  assert.deepEqual(
    [...new Set(rewards.scoreRewards.map((reward) => reward.entry.resourceId))],
    [1]
  );
  assert.equal(rewards.comboRewards.length, 16);
  assert.deepEqual(
    [...new Set(rewards.comboRewards.map((reward) => reward.difficulty))],
    ["easy", "normal", "hard", "expert"]
  );
  assert.deepEqual(
    [...new Set(rewards.comboRewards.map((reward) => reward.comboRateType))],
    [0, 1, 2, 3]
  );
  assert.deepEqual(
    [...new Set(rewards.comboRewards.map((reward) => reward.entry.resourceId))],
    [3, 1]
  );
});

test("music details keep shared rewards and function entries above modal workspaces", async () => {
  const [page, summary, workbench] = await Promise.all([
    readSource("../src/pages/music/[id].astro"),
    readSource("../src/components/MusicChartSummary.astro"),
    readSource("../src/components/ScoreWorkbench.astro")
  ]);
  const markers = [
    ["gekisou", page.indexOf('class="song-gekisou-panel"')],
    ["summary", page.indexOf("<MusicChartSummary")],
    ["scoreRewards", page.indexOf("<MusicScoreRewards")],
    ["actions", page.indexOf('class="song-chart-links"')],
    ["tools", page.indexOf('class="song-tool-links"')],
    ["score", page.indexOf("<ScoreWorkbench")],
    ["rewards", page.indexOf("<MusicSoloRewards")]
  ];
  assert.ok(markers.every(([, index]) => index >= 0));
  assert.doesNotMatch(page, /song-panel-details|track-provenance|track-module-tabs/);
  assert.match(page, /<dialog[^>]*data-song-dialog/);

  assert.deepEqual(
    {
      order: markers.toSorted((left, right) => left[1] - right[1]).map(([name]) => name),
      summaryOwners: [
        summary.includes("data-current-chart-summary") && "MusicChartSummary",
        workbench.includes("chart-summary-grid") && "ScoreWorkbench"
      ].filter(Boolean),
      compactFields: summary.includes("chart.difficulty") && summary.includes("chart.displayLevel")
    },
    {
      order: ["gekisou", "summary", "actions", "tools", "scoreRewards", "score", "rewards"],
      summaryOwners: ["MusicChartSummary"],
      compactFields: true
    }
  );
});

test("mobile music details keep art bounded and chart controls readable", async () => {
  const [page, summary, css] = await Promise.all([
    readSource("../src/pages/music/[id].astro"),
    readSource("../src/components/MusicChartSummary.astro"),
    readSource("../src/styles/song-record.css")
  ]);

  assert.deepEqual(
    {
      albumLayout: page.includes('class="song-album"') && page.includes('class="song-album-grid"'),
      completeSummary: ["combo", "bpm", "average", "peak", "notes", "events"]
        .every((field) => summary.includes(`data-page-summary="${field}"`)),
      mobileSummaryColumns:
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.song-chart-panel \.music-current-chart-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s.test(css),
      boundedArt:
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.song-art-column\s*\{[^}]*width:\s*min\(65%,\s*280px\)/s.test(css),
      singleColumn:
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.song-album-grid\s*\{[^}]*grid-template-columns:\s*1fr/s.test(css),
      usableDifficultyButtons:
        /@media\s*\(max-width:\s*700px\)[\s\S]*?\.music-chart-summary-tabs button\s*\{[^}]*min-height:\s*40px/s.test(css)
    },
    {
      albumLayout: true,
      completeSummary: true,
      mobileSummaryColumns: true,
      boundedArt: true,
      singleColumn: true,
      usableDifficultyButtons: true
    }
  );
});

test("music directory keeps one mobile column and the complete track decision", async () => {
  const [page, tile, css] = await Promise.all([
    readSource("../src/pages/music/index.astro"),
    readSource("../src/components/MusicTile.astro"),
    readSource("../src/styles/music-archive.css")
  ]);
  const finalTwoColumnRule = css.lastIndexOf(
    "grid-template-columns: repeat(2, minmax(0, 1fr));"
  );
  const finalMobileDirectoryRule = css.lastIndexOf(
    ".music-catalog-list,\n  .music-catalog-list--related"
  );

  assert.deepEqual(
    {
      explicitDefault: /<MusicTile\s+track=\{track\}\s+variant="default"\s*\/>/.test(page),
      explicitRelatedType: /variant\?:\s*"default"\s*\|\s*"related"/.test(tile),
      compactDirectory: !page.includes("music-hero--directory") && !/<h1(?:\s|>)/.test(page) && page.includes("music-catalog-section--directory"),
      mobileSingleColumn:
        finalMobileDirectoryRule > finalTwoColumnRule &&
        css.slice(finalMobileDirectoryRule, finalMobileDirectoryRule + 180)
          .includes("grid-template-columns: minmax(0, 1fr)"),
      shrinkableDecisionColumns:
        /\.difficulty-strip\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s.test(css) &&
        /\.music-tile-heading\s*>\s*div\s*\{[^}]*min-width:\s*0/s.test(css),
      retainedFields: [
        "music-jacket",
        "track.title",
        "BandMark",
        "music-bpm",
        'aria-label="四档难度"'
      ].every((marker) => tile.includes(marker)),
      bpmHiddenAtMobile: /@media \(max-width: 440px\)[\s\S]*?\.music-bpm,[\s\S]*?display:\s*none/.test(css)
    },
    {
      explicitDefault: true,
      explicitRelatedType: true,
      compactDirectory: true,
      mobileSingleColumn: true,
      shrinkableDecisionColumns: true,
      retainedFields: true,
      bpmHiddenAtMobile: false
    }
  );
});


test("character details keep three bounded related previews with explicit destinations", async () => {
  const page = await readSource("../src/pages/characters/[id].astro");

  assert.deepEqual(
    {
      previewLimits: [...page.matchAll(/slice\(0,\s*(\d+)\)/g)].map((match) => Number(match[1])),
      viewAllLabels: (page.match(/\{ui\.all\}/g) ?? []).length,
      songDestination: page.includes('class="character-music-card" href={`/music/${track.id}/`}'),
      songTitle: page.includes("<h3>{track.title}</h3>"),
      singerLabels: page.includes('track.vocalistLabels.join(" / ")')
    },
    {
      previewLimits: [4, 4, 4],
      viewAllLabels: 3,
      songDestination: true,
      songTitle: true,
      singerLabels: true
    }
  );
});
