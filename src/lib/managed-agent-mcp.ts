import { ANTHROPIC_BETA } from '../anthropic';
import { toolsHash } from './agent-cache';

const AGENT_MCP_ENSURED_PREFIX = 'agent_mcp_ensured';
const AGENT_MCP_ENSURED_TTL_SEC = 24 * 60 * 60;

export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';
export const DEFAULT_PLAYWRIGHT_MCP_ENABLED_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
] as const;

const SAFE_PLAYWRIGHT_MCP_TOOLS = new Set<string>(DEFAULT_PLAYWRIGHT_MCP_ENABLED_TOOLS);

export interface PlaywrightMcpConfig {
  status:
    | 'not_configured'
    | 'invalid_url'
    | 'auth_boundary_unconfirmed'
    | 'configured'
    | 'no_enabled_tools';
  attach: boolean;
  reason: string;
  server?: Record<string, unknown>;
  toolset?: Record<string, unknown>;
  enabledTools: string[];
  localInsecureAllowed: boolean;
}

export interface EnsureManagedAgentMcpResult {
  checked: boolean;
  updated: boolean;
  reason:
    | 'disabled'
    | 'ensured_cache_hit'
    | 'already_attached'
    | 'updated'
    | 'unsupported_client'
    | 'no_agent_id';
  finalMcpServers: Array<Record<string, unknown>>;
  finalTools: Array<Record<string, unknown>>;
}

interface AgentMcpKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

interface ManagedAgentsMcpApi {
  retrieve(
    agentId: string,
    params?: { betas?: string[] },
  ): Promise<{ version?: number; mcp_servers?: unknown; tools?: unknown }>;
  update(
    agentId: string,
    params: {
      version: number;
      mcp_servers?: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
      betas?: string[];
    },
  ): Promise<unknown>;
}

function managedAgentsMcpApi(client: unknown): ManagedAgentsMcpApi | null {
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
  return agents as ManagedAgentsMcpApi;
}

function envString(env: Env | undefined, key: string): string {
  if (!env) return '';
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function envFlag(env: Env | undefined, key: string): boolean {
  const value = envString(env, key).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    return [item as Record<string, unknown>];
  });
}

function mcpServerKey(server: Record<string, unknown>): string {
  if (server.type === 'url' && typeof server.name === 'string') {
    return `url:${server.name}`;
  }
  if (typeof server.name === 'string') return `name:${server.name}`;
  return JSON.stringify(server);
}

function toolKey(tool: Record<string, unknown>): string {
  if (tool.type === 'custom' && typeof tool.name === 'string') {
    return `custom:${tool.name}`;
  }
  if (tool.type === 'mcp_toolset' && typeof tool.mcp_server_name === 'string') {
    return `mcp_toolset:${tool.mcp_server_name}`;
  }
  if (typeof tool.type === 'string') return `type:${tool.type}`;
  return JSON.stringify(tool);
}

function replaceOrAppendByKey(
  current: unknown,
  desired: readonly Record<string, unknown>[],
  keyFn: (value: Record<string, unknown>) => string,
): { merged: Array<Record<string, unknown>>; changed: boolean } {
  const merged = normalizeRecords(current);
  const indexByKey = new Map<string, number>();
  merged.forEach((item, index) => indexByKey.set(keyFn(item), index));

  let changed = false;
  for (const item of desired) {
    const key = keyFn(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      changed = true;
      continue;
    }
    if (JSON.stringify(merged[existingIndex]) !== JSON.stringify(item)) {
      merged[existingIndex] = item;
      changed = true;
    }
  }
  return { merged, changed };
}

export function mergeManagedAgentMcp(
  currentMcpServers: unknown,
  currentTools: unknown,
  desiredMcpServers: readonly Record<string, unknown>[],
  desiredToolsets: readonly Record<string, unknown>[],
): {
  mergedMcpServers: Array<Record<string, unknown>>;
  mergedTools: Array<Record<string, unknown>>;
  changed: boolean;
} {
  const servers = replaceOrAppendByKey(currentMcpServers, desiredMcpServers, mcpServerKey);
  const tools = replaceOrAppendByKey(currentTools, desiredToolsets, toolKey);
  return {
    mergedMcpServers: servers.merged,
    mergedTools: tools.merged,
    changed: servers.changed || tools.changed,
  };
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function hasMcpPath(url: URL): boolean {
  return url.pathname.replace(/\/+$/, '') === '/mcp';
}

function parseEnabledTools(env: Env | undefined): string[] {
  const configured = envString(env, 'PLAYWRIGHT_MCP_ENABLED_TOOLS');
  const raw = configured
    ? configured.split(',')
    : [...DEFAULT_PLAYWRIGHT_MCP_ENABLED_TOOLS];
  const unique = new Set<string>();
  for (const item of raw) {
    const name = item.trim();
    if (!name || !SAFE_PLAYWRIGHT_MCP_TOOLS.has(name)) continue;
    unique.add(name);
  }
  return [...unique];
}

export function buildPlaywrightMcpConfig(env: Env | undefined): PlaywrightMcpConfig {
  const rawUrl = envString(env, 'PLAYWRIGHT_MCP_URL');
  const localInsecureAllowed = envFlag(env, 'PLAYWRIGHT_MCP_ALLOW_INSECURE_LOCAL');
  if (!rawUrl) {
    return {
      status: 'not_configured',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_URL unset',
      enabledTools: [],
      localInsecureAllowed,
    };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      status: 'invalid_url',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_URL is not a valid URL',
      enabledTools: [],
      localInsecureAllowed,
    };
  }

  const isPrivate = isLocalOrPrivateHost(url.hostname);
  const isLocalSmoke = isPrivate && localInsecureAllowed;
  if (!hasMcpPath(url)) {
    return {
      status: 'invalid_url',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_URL must point at /mcp',
      enabledTools: [],
      localInsecureAllowed,
    };
  }
  if (url.protocol !== 'https:' && !isLocalSmoke) {
    return {
      status: 'invalid_url',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_URL must use HTTPS outside local smoke tests',
      enabledTools: [],
      localInsecureAllowed,
    };
  }
  if (isPrivate && !isLocalSmoke) {
    return {
      status: 'invalid_url',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_URL cannot target localhost or a private IP without local smoke opt-in',
      enabledTools: [],
      localInsecureAllowed,
    };
  }
  if (!isLocalSmoke && !envFlag(env, 'PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED')) {
    return {
      status: 'auth_boundary_unconfirmed',
      attach: false,
      reason: 'PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED unset',
      enabledTools: [],
      localInsecureAllowed,
    };
  }

  const enabledTools = parseEnabledTools(env);
  if (enabledTools.length === 0) {
    return {
      status: 'no_enabled_tools',
      attach: false,
      reason: 'no allowed Playwright MCP tools configured',
      enabledTools,
      localInsecureAllowed,
    };
  }

  return {
    status: 'configured',
    attach: true,
    reason: isLocalSmoke ? 'local smoke enabled' : 'auth boundary confirmed',
    server: {
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      type: 'url',
      url: url.toString(),
    },
    toolset: {
      type: 'mcp_toolset',
      mcp_server_name: PLAYWRIGHT_MCP_SERVER_NAME,
      default_config: {
        enabled: false,
        permission_policy: { type: 'always_allow' },
      },
      configs: enabledTools.map((name) => ({
        name,
        enabled: true,
        permission_policy: { type: 'always_allow' },
      })),
    },
    enabledTools,
    localInsecureAllowed,
  };
}

export async function playwrightMcpHash(config: PlaywrightMcpConfig): Promise<string> {
  if (!config.attach || !config.server || !config.toolset) return 'none';
  return toolsHash([config.server, config.toolset]);
}

function ensuredKey(agentId: string, desiredMcpHash: string): string {
  return `${AGENT_MCP_ENSURED_PREFIX}:${agentId}:${desiredMcpHash}`;
}

export async function ensureManagedAgentMcp(
  client: unknown,
  agentId: string,
  config: PlaywrightMcpConfig,
  options: {
    kv?: AgentMcpKv;
    desiredMcpHash?: string;
  } = {},
): Promise<EnsureManagedAgentMcpResult> {
  if (!config.attach || !config.server || !config.toolset) {
    return {
      checked: false,
      updated: false,
      reason: 'disabled',
      finalMcpServers: [],
      finalTools: [],
    };
  }
  if (!agentId.trim()) {
    return { checked: false, updated: false, reason: 'no_agent_id', finalMcpServers: [], finalTools: [] };
  }

  const api = managedAgentsMcpApi(client);
  if (!api) {
    return {
      checked: false,
      updated: false,
      reason: 'unsupported_client',
      finalMcpServers: [],
      finalTools: [],
    };
  }

  const cacheKey =
    options.kv && options.desiredMcpHash
      ? ensuredKey(agentId, options.desiredMcpHash)
      : null;
  if (cacheKey) {
    const cached = await options.kv!.get(cacheKey);
    if (cached === 'ok') {
      return {
        checked: false,
        updated: false,
        reason: 'ensured_cache_hit',
        finalMcpServers: [config.server],
        finalTools: [config.toolset],
      };
    }
  }

  const agent = await api.retrieve(agentId, { betas: [ANTHROPIC_BETA] });
  const { mergedMcpServers, mergedTools, changed } = mergeManagedAgentMcp(
    agent.mcp_servers,
    agent.tools,
    [config.server],
    [config.toolset],
  );

  if (!changed) {
    if (cacheKey) {
      await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_MCP_ENSURED_TTL_SEC });
    }
    return {
      checked: true,
      updated: false,
      reason: 'already_attached',
      finalMcpServers: mergedMcpServers,
      finalTools: mergedTools,
    };
  }

  if (typeof agent.version !== 'number') {
    throw new Error(`agents.retrieve(${agentId}) did not return numeric version`);
  }
  await api.update(agentId, {
    version: agent.version,
    mcp_servers: mergedMcpServers,
    tools: mergedTools,
    betas: [ANTHROPIC_BETA],
  });
  if (cacheKey) {
    await options.kv!.put(cacheKey, 'ok', { expirationTtl: AGENT_MCP_ENSURED_TTL_SEC });
  }
  return {
    checked: true,
    updated: true,
    reason: 'updated',
    finalMcpServers: mergedMcpServers,
    finalTools: mergedTools,
  };
}
