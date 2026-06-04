import { describe, expect, it } from 'vitest';

import { buildMakotoIntrospection } from '../src/lib/makoto-capability-registry';
import {
  buildPlaywrightMcpConfig,
  ensureManagedAgentMcp,
  mergeManagedAgentMcp,
  playwrightMcpHash,
} from '../src/lib/managed-agent-mcp';

describe('Playwright MCP config', () => {
  it('keeps production behaviour unchanged when URL is unset', () => {
    const config = buildPlaywrightMcpConfig({} as Env);
    expect(config).toMatchObject({
      status: 'not_configured',
      attach: false,
      enabledTools: [],
    });
  });

  it('rejects public HTTPS URLs until the operator confirms the auth boundary', () => {
    const config = buildPlaywrightMcpConfig({
      PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
    } as Env);
    expect(config).toMatchObject({
      status: 'auth_boundary_unconfirmed',
      attach: false,
    });
  });

  it('rejects non-MCP paths and insecure local URLs unless local smoke is explicit', () => {
    expect(
      buildPlaywrightMcpConfig({
        PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/not-mcp',
        PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
      } as Env).status,
    ).toBe('invalid_url');
    expect(
      buildPlaywrightMcpConfig({
        PLAYWRIGHT_MCP_URL: 'http://127.0.0.1:8931/mcp',
      } as Env).status,
    ).toBe('invalid_url');
  });

  it('builds a disabled-by-default MCP toolset with read-only defaults', () => {
    const config = buildPlaywrightMcpConfig({
      PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
      PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
    } as Env);

    expect(config.attach).toBe(true);
    expect(config.server).toEqual({
      name: 'playwright',
      type: 'url',
      url: 'https://playwright.example.com/mcp',
    });
    expect(config.toolset).toEqual({
      type: 'mcp_toolset',
      mcp_server_name: 'playwright',
      default_config: {
        enabled: false,
        permission_policy: { type: 'always_allow' },
      },
      configs: [
        {
          name: 'browser_navigate',
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
        {
          name: 'browser_snapshot',
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
      ],
    });
  });

  it('allows local loopback only for explicit smoke tests', () => {
    const config = buildPlaywrightMcpConfig({
      PLAYWRIGHT_MCP_URL: 'http://127.0.0.1:8931/mcp',
      PLAYWRIGHT_MCP_ALLOW_INSECURE_LOCAL: '1',
    } as Env);
    expect(config).toMatchObject({
      status: 'configured',
      attach: true,
      localInsecureAllowed: true,
    });
  });

  it('filters denied mutation or execution tools from the explicit allowlist', () => {
    const config = buildPlaywrightMcpConfig({
      PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
      PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
      PLAYWRIGHT_MCP_ENABLED_TOOLS:
        'browser_navigate,browser_click,browser_type,browser_snapshot,browser_evaluate',
    } as Env);
    expect(config.enabledTools).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_snapshot',
    ]);
  });

  it('allows screenshots only when explicitly configured', () => {
    const config = buildPlaywrightMcpConfig({
      PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
      PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
      PLAYWRIGHT_MCP_ENABLED_TOOLS:
        'browser_navigate,browser_snapshot,browser_take_screenshot',
    } as Env);
    expect(config.enabledTools).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_take_screenshot',
    ]);
  });

  it('hash changes only when MCP attaches', async () => {
    await expect(playwrightMcpHash(buildPlaywrightMcpConfig({} as Env))).resolves.toBe('none');
    const hash = await playwrightMcpHash(
      buildPlaywrightMcpConfig({
        PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
        PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
      } as Env),
    );
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('managed agent MCP merge', () => {
  const desiredConfig = buildPlaywrightMcpConfig({
    PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
    PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
  } as Env);

  it('preserves existing MCP servers, other MCP toolsets, and custom tools', () => {
    const result = mergeManagedAgentMcp(
      [{ name: 'other', type: 'url', url: 'https://other.example.com/mcp' }],
      [
        { type: 'agent_toolset_20260401' },
        { type: 'custom', name: 'drive_search' },
        { type: 'mcp_toolset', mcp_server_name: 'other', default_config: { enabled: true } },
      ],
      [desiredConfig.server!],
      [desiredConfig.toolset!],
    );

    expect(result.changed).toBe(true);
    expect(result.mergedMcpServers).toEqual([
      { name: 'other', type: 'url', url: 'https://other.example.com/mcp' },
      desiredConfig.server,
    ]);
    expect(result.mergedTools).toEqual([
      { type: 'agent_toolset_20260401' },
      { type: 'custom', name: 'drive_search' },
      { type: 'mcp_toolset', mcp_server_name: 'other', default_config: { enabled: true } },
      desiredConfig.toolset,
    ]);
  });

  it('replaces the existing Playwright MCP entry without duplicating it', () => {
    const result = mergeManagedAgentMcp(
      [{ name: 'playwright', type: 'url', url: 'https://old.example.com/mcp' }],
      [
        {
          type: 'mcp_toolset',
          mcp_server_name: 'playwright',
          default_config: { enabled: true },
        },
      ],
      [desiredConfig.server!],
      [desiredConfig.toolset!],
    );

    expect(result.changed).toBe(true);
    expect(result.mergedMcpServers).toEqual([desiredConfig.server]);
    expect(result.mergedTools).toEqual([desiredConfig.toolset]);
  });

  it('updates the agent with merged mcp_servers and tools', async () => {
    const updateCalls: unknown[] = [];
    const client = {
      beta: {
        agents: {
          async retrieve() {
            return {
              version: 11,
              mcp_servers: [{ name: 'other', type: 'url', url: 'https://other.example.com/mcp' }],
              tools: [{ type: 'custom', name: 'drive_search' }],
            };
          },
          async update(_agentId: string, params: unknown) {
            updateCalls.push(params);
            return { id: 'agent_001' };
          },
        },
      },
    };

    const result = await ensureManagedAgentMcp(client, 'agent_001', desiredConfig);

    expect(result.updated).toBe(true);
    expect(updateCalls).toEqual([
      {
        version: 11,
        mcp_servers: [
          { name: 'other', type: 'url', url: 'https://other.example.com/mcp' },
          desiredConfig.server,
        ],
        tools: [{ type: 'custom', name: 'drive_search' }, desiredConfig.toolset],
        betas: ['managed-agents-2026-04-01'],
      },
    ]);
  });
});

describe('Playwright MCP introspection', () => {
  it('redacts the MCP URL from makoto_introspect output', async () => {
    const payload = await buildMakotoIntrospection(
      { detail: 'mcp' },
      {
        PLAYWRIGHT_MCP_URL: 'https://playwright.example.com/mcp',
        PLAYWRIGHT_MCP_AUTH_BOUNDARY_CONFIRMED: '1',
      } as Env,
    );

    expect(payload.mcp).toMatchObject({
      status: 'configured_for_browser_automation',
      playwright: {
        status: 'configured',
        attach: true,
        url_redacted: true,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('https://playwright.example.com/mcp');
  });
});
