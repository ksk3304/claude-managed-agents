import { describe, expect, it } from 'vitest';

import {
  buildAllManagedAgentSkills,
  buildMailSendSkills,
  ensureManagedAgentSkills,
  hasAttachedSkills,
  mergeAttachedSkills,
} from '../src/lib/attached-skills';

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

  it('attaches built-in document skills by default', () => {
    expect(buildAllManagedAgentSkills({} as Env)).toEqual([
      { type: 'anthropic', skill_id: 'xlsx' },
      { type: 'anthropic', skill_id: 'pptx' },
      { type: 'anthropic', skill_id: 'docx' },
      { type: 'anthropic', skill_id: 'pdf' },
    ]);
  });

  it('appends configured custom skills with pinned versions', () => {
    const skills = buildAllManagedAgentSkills({
      PROVENANCE_SKILL_ID: 'skill_prov',
      PROVENANCE_SKILL_VERSION: '20260514',
      CLOUDRUN_SKILL_ID: 'skill_cloudrun',
      MAIL_SEND_SKILL_ID: 'skill_mail',
      MAIL_SEND_SKILL_VERSION: '20260526',
      COST_GUARD_SKILL_ID: 'skill_cost',
      COST_GUARD_SKILL_VERSION: '20260601',
    } as Env);

    expect(skills).toEqual([
      { type: 'anthropic', skill_id: 'xlsx' },
      { type: 'anthropic', skill_id: 'pptx' },
      { type: 'anthropic', skill_id: 'docx' },
      { type: 'anthropic', skill_id: 'pdf' },
      { type: 'custom', skill_id: 'skill_prov', version: '20260514' },
      { type: 'custom', skill_id: 'skill_cloudrun' },
      { type: 'custom', skill_id: 'skill_mail', version: '20260526' },
      { type: 'custom', skill_id: 'skill_cost', version: '20260601' },
    ]);
  });

  it('merges document skills without dropping existing custom skills', () => {
    const merged = mergeAttachedSkills(
      [{ type: 'custom', skill_id: 'skill_existing', version: '1' }],
      buildAllManagedAgentSkills({} as Env),
    );

    expect(merged.changed).toBe(true);
    expect(merged.merged).toEqual([
      { type: 'custom', skill_id: 'skill_existing', version: '1' },
      { type: 'anthropic', skill_id: 'xlsx' },
      { type: 'anthropic', skill_id: 'pptx' },
      { type: 'anthropic', skill_id: 'docx' },
      { type: 'anthropic', skill_id: 'pdf' },
    ]);
  });

  it('updates an existing agent when required skills are missing', async () => {
    const updateCalls: unknown[] = [];
    const client = {
      beta: {
        agents: {
          async retrieve() {
            return {
              version: 7,
              skills: [{ type: 'custom', skill_id: 'skill_existing', version: '1' }],
            };
          },
          async update(_agentId: string, params: unknown) {
            updateCalls.push(params);
            return { id: 'agent_001' };
          },
        },
      },
    };

    const result = await ensureManagedAgentSkills(
      client,
      'agent_001',
      buildAllManagedAgentSkills({} as Env),
    );

    expect(result.updated).toBe(true);
    expect(updateCalls).toEqual([
      {
        version: 7,
        skills: [
          { type: 'custom', skill_id: 'skill_existing', version: '1' },
          { type: 'anthropic', skill_id: 'xlsx' },
          { type: 'anthropic', skill_id: 'pptx' },
          { type: 'anthropic', skill_id: 'docx' },
          { type: 'anthropic', skill_id: 'pdf' },
        ],
        betas: ['managed-agents-2026-04-01'],
      },
    ]);
  });
});
