/**
 * Anthropic Managed Agents skill attachment helpers.
 *
 * `skills-data.ts` is the local slash-command catalog. This file is for
 * external Anthropic Skills that appear in Claude Console or Anthropic
 * pre-built Skills and are attached to a Managed Agent at agent creation time.
 */

import { ANTHROPIC_BETA } from '../anthropic';

export type CustomAttachedSkill = {
  type: 'custom';
  skill_id: string;
  version?: string | null;
};

export type AnthropicAttachedSkill = {
  type: 'anthropic';
  skill_id: string;
  version?: string | null;
};

export type AttachedSkill = CustomAttachedSkill | AnthropicAttachedSkill;

export const BUILT_IN_DOCUMENT_SKILL_IDS = ['xlsx', 'pptx', 'docx', 'pdf'] as const;
const AGENT_SKILLS_ENSURED_PREFIX = 'agent_skills_ensured';
const AGENT_SKILLS_ENSURED_TTL_SEC = 24 * 60 * 60;

const CUSTOM_SKILL_ENV_SPECS = [
  {
    label: 'provenance',
    idKey: 'PROVENANCE_SKILL_ID',
    versionKey: 'PROVENANCE_SKILL_VERSION',
  },
  {
    label: 'cloudrun',
    idKey: 'CLOUDRUN_SKILL_ID',
    versionKey: 'CLOUDRUN_SKILL_VERSION',
  },
  {
    label: 'mail-send',
    idKey: 'MAIL_SEND_SKILL_ID',
    versionKey: 'MAIL_SEND_SKILL_VERSION',
  },
  {
    label: 'cost-guard',
    idKey: 'COST_GUARD_SKILL_ID',
    versionKey: 'COST_GUARD_SKILL_VERSION',
  },
] as const;

function envString(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function buildMailSendSkills(env: Env): AttachedSkill[] {
  const skillId = envString(env, 'MAIL_SEND_SKILL_ID');
  if (!skillId) return [];

  const skill: CustomAttachedSkill = {
    type: 'custom',
    skill_id: skillId,
  };
  const version = envString(env, 'MAIL_SEND_SKILL_VERSION');
  if (version) {
    skill.version = version;
  }
  return [skill];
}

export function buildAllManagedAgentSkills(env: Env): AttachedSkill[] {
  const skills: AttachedSkill[] = BUILT_IN_DOCUMENT_SKILL_IDS.map((skillId) => ({
    type: 'anthropic',
    skill_id: skillId,
  }));

  for (const spec of CUSTOM_SKILL_ENV_SPECS) {
    const skillId = envString(env, spec.idKey);
    if (!skillId) continue;
    const skill: CustomAttachedSkill = {
      type: 'custom',
      skill_id: skillId,
    };
    const version = envString(env, spec.versionKey);
    if (version) {
      skill.version = version;
    }
    skills.push(skill);
  }

  return skills;
}

export function hasAttachedSkills(
  skills: Array<Record<string, unknown>> | null | undefined,
): boolean {
  return Array.isArray(skills) && skills.length > 0;
}

export interface EnsureManagedAgentSkillsResult {
  checked: boolean;
  updated: boolean;
  reason: 'ensured_cache_hit' | 'already_attached' | 'updated' | 'unsupported_client' | 'no_agent_id';
  finalSkills: AttachedSkill[];
}

interface AttachedSkillsKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

interface ManagedAgentsApi {
  retrieve(
    agentId: string,
    params?: { betas?: string[] },
  ): Promise<{ version?: number; skills?: unknown }>;
  update(
    agentId: string,
    params: { version: number; skills: AttachedSkill[]; betas?: string[] },
  ): Promise<unknown>;
}

function managedAgentsApi(client: unknown): ManagedAgentsApi | null {
  const maybe = client as {
    beta?: {
      agents?: {
        retrieve?: unknown;
        update?: unknown;
      };
    };
  };
  const agents = maybe.beta?.agents;
  if (
    !agents ||
    typeof agents.retrieve !== 'function' ||
    typeof agents.update !== 'function'
  ) {
    return null;
  }
  return agents as ManagedAgentsApi;
}

function skillKey(skill: Pick<AttachedSkill, 'type' | 'skill_id'>): string {
  return `${skill.type}:${skill.skill_id}`;
}

function normalizeSkill(value: unknown): AttachedSkill | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (record.type !== 'anthropic' && record.type !== 'custom') ||
    typeof record.skill_id !== 'string' ||
    record.skill_id.trim().length === 0
  ) {
    return null;
  }
  const base: AttachedSkill = {
    type: record.type,
    skill_id: record.skill_id.trim(),
  } as AttachedSkill;
  if (typeof record.version === 'string' && record.version.trim().length > 0) {
    return { ...base, version: record.version.trim() } as AttachedSkill;
  }
  return base;
}

export function normalizeAttachedSkills(value: unknown): AttachedSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const skill = normalizeSkill(item);
    return skill ? [skill] : [];
  });
}

export function mergeAttachedSkills(
  current: readonly AttachedSkill[],
  desired: readonly AttachedSkill[],
): { merged: AttachedSkill[]; changed: boolean } {
  const merged = [...current];
  const index = new Map<string, number>();
  for (const [i, skill] of merged.entries()) {
    index.set(skillKey(skill), i);
  }

  let changed = false;
  for (const desiredSkill of desired) {
    const key = skillKey(desiredSkill);
    const existingIndex = index.get(key);
    if (existingIndex === undefined) {
      index.set(key, merged.length);
      merged.push(desiredSkill);
      changed = true;
      continue;
    }
    const existing = merged[existingIndex]!;
    if (desiredSkill.version !== undefined && desiredSkill.version !== existing.version) {
      merged[existingIndex] = desiredSkill;
      changed = true;
    }
  }

  return { merged, changed };
}

function ensuredKey(agentId: string, desiredSkillsHash: string): string {
  return `${AGENT_SKILLS_ENSURED_PREFIX}:${agentId}:${desiredSkillsHash}`;
}

export async function ensureManagedAgentSkills(
  client: unknown,
  agentId: string,
  desiredSkills: AttachedSkill[],
  options: {
    kv?: AttachedSkillsKv;
    desiredSkillsHash?: string;
  } = {},
): Promise<EnsureManagedAgentSkillsResult> {
  if (!agentId.trim()) {
    return { checked: false, updated: false, reason: 'no_agent_id', finalSkills: [] };
  }

  const api = managedAgentsApi(client);
  if (!api) {
    return { checked: false, updated: false, reason: 'unsupported_client', finalSkills: [] };
  }

  const cacheKey =
    options.kv && options.desiredSkillsHash
      ? ensuredKey(agentId, options.desiredSkillsHash)
      : null;
  if (cacheKey) {
    const cached = await options.kv!.get(cacheKey);
    if (cached === 'ok') {
      return {
        checked: false,
        updated: false,
        reason: 'ensured_cache_hit',
        finalSkills: desiredSkills,
      };
    }
  }

  const agent = await api.retrieve(agentId, { betas: [ANTHROPIC_BETA] });
  const current = normalizeAttachedSkills(agent.skills);
  const { merged, changed } = mergeAttachedSkills(current, desiredSkills);

  if (!changed) {
    if (cacheKey) {
      await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_SKILLS_ENSURED_TTL_SEC });
    }
    return { checked: true, updated: false, reason: 'already_attached', finalSkills: merged };
  }

  if (typeof agent.version !== 'number') {
    throw new Error(`agents.retrieve(${agentId}) did not return numeric version`);
  }
  await api.update(agentId, {
    version: agent.version,
    skills: merged,
    betas: [ANTHROPIC_BETA],
  });
  if (cacheKey) {
    await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_SKILLS_ENSURED_TTL_SEC });
  }
  return { checked: true, updated: true, reason: 'updated', finalSkills: merged };
}
