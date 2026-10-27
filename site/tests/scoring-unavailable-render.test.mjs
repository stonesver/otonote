import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer } from "astro/container";
import { transform as transpile } from "esbuild";

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
  export const filterVisualOptions = {}, gameModeDatabase = { events: { records: [] } };
  export const siteHref = path => path;
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

for (const rules of [
  {sourceReleaseId:"remote-hotfix",verificationStatus:"unavailable",reason:"missing_scoring_inputs"},
  {sourceReleaseId:"previous-release",verificationStatus:"code_audited"},
]) {
  test(`AP grade: ${rules.verificationStatus} rules without tables render the unavailable state`, async () => {
    const url = new URL("../src/pages/tools/ap-grade/index.astro", import.meta.url);
    const compiled = await transform(await readFile(url, "utf8"), {filename:url.pathname,internalURL:"astro/compiler-runtime"});
    const stub = await transform("<slot />", {filename:"Stub.astro",internalURL:"astro/compiler-runtime"});
    const layout = moduleUrl(stub.code.replaceAll('"astro/compiler-runtime"', JSON.stringify(runtime)));
    const ruleModule = moduleUrl(`export default ${JSON.stringify(rules)};`);
    const {code} = await transpile(compiled.code, {loader:"ts",format:"esm"});
    const rewritten = code.replace(/(["'])(astro\/compiler-runtime|\.\.?\/[^"']+)\1/g, (whole, quote, specifier) => {
      if (specifier === "astro/compiler-runtime") return JSON.stringify(runtime);
      if (specifier.endsWith(".astro")) return JSON.stringify(layout);
      if (specifier.endsWith("formal-scoring-rules.json")) return JSON.stringify(ruleModule);
      if (/\/(ap-grade|scoring-release-gate)\.mjs$/.test(specifier)) return JSON.stringify(new URL(specifier,url).href);
      return JSON.stringify(projection);
    });
    const {default:Page} = await import(moduleUrl(rewritten));
    const container = await experimental_AstroContainer.create();
    const html = await container.renderToString(Page);
    assert.match(html, /当前版本暂不可计算 AP 档位/);
    assert.doesNotMatch(html, /<ap-grade-tool|data-ap-inputs|data-ap-run/);
  });
}
