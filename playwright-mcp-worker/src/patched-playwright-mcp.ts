import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// @ts-expect-error Cloudflare's package keeps these internals private, but the public wrapper is too narrow for this SSE bridge.
import { contextFactory } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/browserContextFactory.js';
// @ts-expect-error Cloudflare's package keeps these internals private, but the public wrapper is too narrow for this SSE bridge.
import { resolveConfig } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/config.js';
// @ts-expect-error Cloudflare's package keeps these internals private, but the public wrapper is too narrow for this SSE bridge.
import { Context } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/context.js';
// @ts-expect-error Cloudflare's package keeps these internals private, but the public wrapper is too narrow for this SSE bridge.
import { packageJSON } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/package.js';
// @ts-expect-error Cloudflare's package keeps these internals private, but the public wrapper is too narrow for this SSE bridge.
import { snapshotTools, visionTools } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools.js';

type PlaywrightMcpTool = {
  capability: string;
  clearsModalState?: string;
  schema: {
    name: string;
    title: string;
    description: string;
    inputSchema: unknown;
    type: string;
  };
  handle: (context: any, params: unknown) => Promise<unknown>;
};

function patchTool(tool: PlaywrightMcpTool): PlaywrightMcpTool {
  if (tool.schema.name !== 'browser_take_screenshot') return tool;
  return {
    ...tool,
    handle: async (context: any, params: unknown) => {
      const tab = await context.ensureTab();
      if (!tab.hasSnapshot()) await tab.captureSnapshot();
      return tool.handle(context, params);
    },
  };
}

function createPatchedConnectionFromConfig(config: any, browserContextFactory: any) {
  const allTools = config.vision ? visionTools : snapshotTools;
  const tools = allTools
    .filter(
      (tool: PlaywrightMcpTool) =>
        !config.capabilities || tool.capability === 'core' || config.capabilities.includes(tool.capability),
    )
    .map(patchTool);
  const context = new Context(tools, config, browserContextFactory);
  const server = new Server(
    { name: 'Playwright', version: packageJSON.version },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool: PlaywrightMcpTool) => ({
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema: zodToJsonSchema(tool.schema.inputSchema as any),
      annotations: {
        title: tool.schema.title,
        readOnlyHint: tool.schema.type === 'readOnly',
        destructiveHint: tool.schema.type === 'destructive',
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const errorResult = (...messages: string[]) => ({
      content: [{ type: 'text' as const, text: messages.join('\n') }],
      isError: true,
    });
    const tool = tools.find((candidate: PlaywrightMcpTool) => candidate.schema.name === request.params.name);
    if (!tool) return errorResult(`Tool "${request.params.name}" not found`);

    const modalStates = context.modalStates().map((state: { type: string }) => state.type);
    if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState)) {
      return errorResult(
        `The tool "${request.params.name}" can only be used when there is related modal state present.`,
        ...context.modalStatesMarkdown(),
      );
    }
    if (!tool.clearsModalState && modalStates.length) {
      return errorResult(`Tool "${request.params.name}" does not handle the modal state.`, ...context.modalStatesMarkdown());
    }

    try {
      return await context.run(tool, request.params.arguments);
    } catch (error) {
      return errorResult(String(error));
    }
  });

  return {
    server,
    context,
    async close() {
      await server.close();
      await context.close();
    },
  };
}

export async function createConnection(userConfig: Record<string, unknown> = {}) {
  const config = await resolveConfig(userConfig);
  const factory = contextFactory(config.browser);
  const connection = createPatchedConnectionFromConfig(config, factory);
  (connection.server as any).oninitialized = () => {
    connection.context.clientVersion = (connection.server as any).getClientVersion();
  };
  return connection;
}
