import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer } from "astro/container";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
// Vite normally consumes compiler metadata and hoisted scripts. This SSR-only
// harness exercises component rendering without a Vite asset manifest.
const runtime = moduleUrl(`export * from ${JSON.stringify(import.meta.resolve("astro/compiler-runtime"))};
  export const createMetadata = (filename, metadata) => metadata;
  export const renderScript = () => "";`);
const projection = moduleUrl(`
  export const sharedTeamPresentation=()=>({filterVisualOptions:{},growthIcons:{}});
  export const catalog = { release: { id: "remote-hotfix", locale: "en" },
    memberCards: [], supportCards: [], musicTracks: [], musicCharts: [], bands: [], characters: [], cardTaxonomy: { attributes: [], rarities: [] } };
  export const cardDetailProjections = { memberCards: [], supportCards: [] };
  export const memberCards = [], supportCards = [], projections = [], skillFilters = {};
  export const globalSystems = { sourceReleaseId: "remote-hotfix", vipRanks: [] };
  export const bandItemDatabase = { items: [] };
  export const activeReleaseContext = { locale: "en" };
  export const scoringEvidence = {};
  export const TEAM_RULE_SET = {};
  export const getAsset = () => null, getBand = () => null, getCharacter = () => null,
    getCardRarity = () => null, getCardAttribute = () => null;
  export const filterVisual = () => ({});
  export const getRuntimeUiLabels = () => ({ locale: "en", teamDraft: {}, scoringResearch: {} });
  export default { sourceReleaseId: "previous-release", verificationStatus: "code_audited" };
`);

async function component(name) {
  const url = new URL(`../src/components/${name}.astro`, import.meta.url);
  const { code } = await transform(await readFile(url, "utf8"), { filename: url.pathname, internalURL: "astro/compiler-runtime" });
  const unavailable = name !== "ScoringUnavailable" ? await component("ScoringUnavailable") : null;
  const rewritten = code.replace(/(["'])(astro\/compiler-runtime|\.\.?\/[^"']+)\1/g,
    (whole, quote, specifier) => {
      let mapped = projection;
      if (specifier.startsWith("astro/")) mapped = runtime;
      else if (specifier.endsWith("scoring-release-gate.mjs")) mapped = new URL("../src/lib/scoring-release-gate.mjs", import.meta.url).href;
      else if (specifier.endsWith("ScoringUnavailable.astro")) mapped = unavailable;
      return JSON.stringify(mapped);
    });
  return moduleUrl(rewritten);
}

for (const name of ["TeamDraftWorkbench", "ScoringResearchWorkbench"]) {
  test(`${name}: an unaudited hot update renders a notice without stale rules or calculator controls`, async () => {
    const container = await experimental_AstroContainer.create();
    const { default: Component } = await import(await component(name));
    const html = await container.renderToString(Component);
    assert.match(html, /data-scoring-unavailable/);
    assert.match(html, /Calculation data unavailable/);
    assert.match(html, /missing or incompatible/);
    assert.doesNotMatch(html, /data-team-draft-data|data-scoring-research-data|data-song-select/);
  });
}
