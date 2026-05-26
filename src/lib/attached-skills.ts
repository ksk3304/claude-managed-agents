/**
 * Anthropic Managed Agents custom skill attachment helpers.
 *
 * `skills-data.ts` is the local slash-command catalog. This file is for
 * external Anthropic Skills that appear in Claude Console and are attached to
 * a Managed Agent at agent creation time.
 */

export type AttachedSkill = {
  type: 'custom';
  skill_id: string;
  version?: string | null;
};

export function buildMailSendSkills(env: Env): AttachedSkill[] {
  const skillId = (env.MAIL_SEND_SKILL_ID ?? '').trim();
  if (!skillId) return [];

  const skill: AttachedSkill = {
    type: 'custom',
    skill_id: skillId,
  };
  const version = (env.MAIL_SEND_SKILL_VERSION ?? '').trim();
  if (version) {
    skill.version = version;
  }
  return [skill];
}

export function hasAttachedSkills(
  skills: Array<Record<string, unknown>> | null | undefined,
): boolean {
  return Array.isArray(skills) && skills.length > 0;
}

