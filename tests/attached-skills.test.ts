import { describe, expect, it } from 'vitest';

import { buildMailSendSkills, hasAttachedSkills } from '../src/lib/attached-skills';

describe('attached skills', () => {
  it('returns no mail skill when MAIL_SEND_SKILL_ID is unset', () => {
    expect(buildMailSendSkills({} as Env)).toEqual([]);
  });

  it('builds a custom mail skill attachment with optional version', () => {
    const skills = buildMailSendSkills({
      MAIL_SEND_SKILL_ID: 'skill_123',
      MAIL_SEND_SKILL_VERSION: '20260526',
    } as Env);
    expect(skills).toEqual([
      { type: 'custom', skill_id: 'skill_123', version: '20260526' },
    ]);
    expect(hasAttachedSkills(skills)).toBe(true);
  });
});

