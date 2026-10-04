import { translateTeamPlanningText } from "./team-planning-translations.mjs";
import {
  englishExactTranslations,
  englishFragmentTranslations
} from "./ui-text-translations.ts";

const titleExactTranslations = Object.entries(englishExactTranslations)
  .filter(([source]) => source.length >= 2)
  .sort(([left], [right]) => right.length - left.length);

export const translateUiText = (value: string) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return value;
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
  const withOriginalSpacing = (translated: string) => {
    const leading = /^[,.;:!?]/.test(translated) ? "" : leadingWhitespace;
    return `${leading}${translated}${trailingWhitespace}`;
  };
  const exact = englishExactTranslations[normalized];
  if (exact) return withOriginalSpacing(exact);

  const planning = translateTeamPlanningText(normalized);
  if (planning !== normalized) return withOriginalSpacing(planning);
  let translated = normalized;
  const episode = translated.match(/^第\s*(\d+)\s*集$/);
  if (episode) return withOriginalSpacing(`Episode ${episode[1]}`);
  const chapterEpisodes = translated.match(
    /^(\d+)\s*章节\s*\/\s*(\d+)\s*集$/
  );
  if (chapterEpisodes) {
    return withOriginalSpacing(
      `${chapterEpisodes[1]} chapters / ` +
        `${chapterEpisodes[2]} episodes`
    );
  }
  const monthDay = translated.match(/^(.*?·\s*)(\d+)月(\d+)日$/);
  if (monthDay) {
    return withOriginalSpacing(
      `${monthDay[1]}${monthDay[2]}/${monthDay[3]}`
    );
  }
  for (const [source, target] of englishFragmentTranslations) {
    translated = translated.split(source).join(target);
  }
  return translated === normalized
    ? value
    : withOriginalSpacing(translated);
};

export const translateUiTitle = (value: string) => {
  let translated = translateUiText(value);
  for (const [source, target] of titleExactTranslations) {
    translated = translated.split(source).join(target);
  }
  return translated;
};
