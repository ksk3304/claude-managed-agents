import { ANTHROPIC_BETA } from '../anthropic';

const AGENT_TOOLS_ENSURED_PREFIX = 'agent_tools_ensured';
const AGENT_TOOLS_ENSURED_TTL_SEC = 24 * 60 * 60;

export interface EnsureManagedAgentToolsResult {
  checked: boolean;
  updated: boolean;
  reason: 'ensured_cache_hit' | 'already_attached' | 'updated' | 'unsupported_client' | 'no_agent_id';
  finalTools: Array<Record<string, unknown>>;
}

interface AgentToolsKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

interface ManagedAgentsToolsApi {
  retrieve(
    agentId: string,
    params?: { betas?: string[] },
  ): Promise<{ version?: number; tools?: unknown }>;
  update(
    agentId: string,
    params: { version: number; tools: Array<Record<string, unknown>>; betas?: string[] },
  ): Promise<unknown>;
}

function managedAgentsToolsApi(client: unknown): ManagedAgentsToolsApi | null {
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
  return agents as ManagedAgentsToolsApi;
}

function toolKey(tool: Record<string, unknown>): string {
  if (tool.type === 'custom' && typeof tool.name === 'string') {
    return `custom:${tool.name}`;
  }
  if (typeof tool.type === 'string') return `type:${tool.type}`;
  return JSON.stringify(tool);
}

function normalizeTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    return [item as Record<string, unknown>];
  });
}

export function mergeManagedAgentTools(
  currentTools: unknown,
  desiredTools: readonly Record<string, unknown>[],
): { merged: Array<Record<string, unknown>>; changed: boolean } {
  const merged = normalizeTools(currentTools);
  const seen = new Set(merged.map(toolKey));
  let changed = false;
  for (const tool of desiredTools) {
    const key = toolKey(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(tool);
    changed = true;
  }
  return { merged, changed };
}

function ensuredKey(agentId: string, desiredToolsHash: string): string {
  return `${AGENT_TOOLS_ENSURED_PREFIX}:${agentId}:${desiredToolsHash}`;
}

export async function ensureManagedAgentTools(
  client: unknown,
  agentId: string,
  desiredTools: readonly Record<string, unknown>[],
  options: {
    kv?: AgentToolsKv;
    desiredToolsHash?: string;
  } = {},
): Promise<EnsureManagedAgentToolsResult> {
  if (!agentId.trim()) {
    return { checked: false, updated: false, reason: 'no_agent_id', finalTools: [] };
  }

  const api = managedAgentsToolsApi(client);
  if (!api) {
    return { checked: false, updated: false, reason: 'unsupported_client', finalTools: [] };
  }

  const cacheKey =
    options.kv && options.desiredToolsHash
      ? ensuredKey(agentId, options.desiredToolsHash)
      : null;
  if (cacheKey) {
    const cached = await options.kv!.get(cacheKey);
    if (cached === 'ok') {
      return {
        checked: false,
        updated: false,
        reason: 'ensured_cache_hit',
        finalTools: [...desiredTools],
      };
    }
  }

  const agent = await api.retrieve(agentId, { betas: [ANTHROPIC_BETA] });
  const { merged, changed } = mergeManagedAgentTools(agent.tools, desiredTools);

  if (!changed) {
    if (cacheKey) {
      await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_TOOLS_ENSURED_TTL_SEC });
    }
    return { checked: true, updated: false, reason: 'already_attached', finalTools: merged };
  }

  if (typeof agent.version !== 'number') {
    throw new Error(`agents.retrieve(${agentId}) did not return numeric version`);
  }
  await api.update(agentId, {
    version: agent.version,
    tools: merged,
    betas: [ANTHROPIC_BETA],
  });
  if (cacheKey) {
    await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_TOOLS_ENSURED_TTL_SEC });
  }
  return { checked: true, updated: true, reason: 'updated', finalTools: merged };
}
