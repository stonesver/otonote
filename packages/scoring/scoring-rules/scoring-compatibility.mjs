import { compileGekisouEffects } from './gekisou-song-score.mjs';
import { createFormalSkillResolver } from './formal-skills.mjs';

/** Diagnostic of the public pool, independent from permission to publish
 * catalog content. Reference rankings do not exercise any card skills. */
export function inspectPublishedSkillsCompatibility(rules, catalog) {
  if (!Array.isArray(catalog.memberCards) || !Array.isArray(catalog.supportCards)) {
    return { status: 'unavailable', checks: 0, issues: [{ message: 'Missing published card catalog for scoring compatibility' }] };
  }
  const members = [...new Set(catalog.memberCards.map(card => card.id))];
  const supports = [...new Set(catalog.supportCards.map(card => card.id))];
  if (!members.length || !supports.length) return { status: 'unavailable', checks: 0, issues: [{ message: 'Empty published card pool for scoring compatibility' }] };
  const resolvers = [createFormalSkillResolver(rules), createFormalSkillResolver(rules, { judgement: 6 }),
    createFormalSkillResolver(rules, { dynamic: true })];
  let checks = 0;
  const issues = [];
  function check(memberCardId, supportCardId, level) {
    const draft = { slots: [{ memberCardId, supportCardId }], modifiers: { growth: {
      [memberCardId]: { skillLevel: level, gekisouSkillLevel: level },
      [supportCardId]: { rank: level },
    } } };
    try {
      for (const resolve of resolvers) resolve(draft);
      compileGekisouEffects(rules, draft);
      compileGekisouEffects(rules, draft, true);
    } catch (error) {
      issues.push({ memberCardId, supportCardId, level, code: error.code ?? 'invalid_skill_data', ...error.detail, message: error.message });
    }
    checks++;
  }
  // Every public member skill level and every support rank is resolved. This
  // uses the runtime validators rather than a second list of effect numbers.
  for (let level = 1; level <= 5; level++) {
    for (const member of members) check(member, supports[0], level);
    for (const support of supports.slice(1)) check(members[0], support, level);
  }
  return { status: issues.length ? 'partial' : 'compatible', sourceReleaseId: rules.sourceReleaseId,
    memberCards: members.length, supportCards: supports.length, checks, issues };
}
