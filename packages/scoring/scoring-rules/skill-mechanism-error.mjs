/** Only a known capability gap may exclude a candidate. Invalid data and
 * programming errors remain failures, rather than silently losing coverage. */
export class UnsupportedSkillMechanismError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UnsupportedSkillMechanismError';
    this.code = 'unsupported_skill_mechanism';
    this.detail = detail;
  }
}

export function skillMechanismIssue(error) {
  if (!(error instanceof UnsupportedSkillMechanismError)) throw error;
  return { code: error.code, message: error.message, ...error.detail };
}
