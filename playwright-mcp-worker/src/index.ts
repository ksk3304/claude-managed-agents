import { endpointURLString } from '@cloudflare/playwright';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpAgent } from 'agents/mcp';
import { env } from 'cloudflare:workers';
// @ts-expect-error @cloudflare/playwright-mcp does not export its per-session connection helper.
import { createConnection } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/index.js';

const cdpEndpoint = endpointURLString(env.BROWSER);

interface PlaywrightMcpConnection {
  server: Server;
}

export class PlaywrightMCP extends McpAgent {
  server = createConnection({
    browser: { cdpEndpoint },
    capabilities: ['core', 'tabs', 'wait'],
  }).then((connection: PlaywrightMcpConnection) => connection.server);

  async init(): Promise<void> {}
}

const mcpHandler = PlaywrightMCP.serve('/mcp', { binding: 'PLAYWRIGHT_MCP' });

function unauthorized(): Response {
  return new Response('unauthorized', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="makoto-playwright-mcp"' },
  });
}

function basicAuthOk(request: Request, expectedUser: string, expectedPass: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === expectedUser && pass === expectedPass;
}

function bearerAuthOk(request: Request, expectedToken: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === expectedToken;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'makoto-playwright-mcp' });
    }

    const bearer = env.MCP_BEARER_TOKEN ?? '';
    const user = (env.MCP_BASIC_USER ?? '').trim();
    const pass = env.MCP_BASIC_PASS ?? '';
    const bearerConfigured = bearer.length > 0;
    const basicConfigured = user.length > 0 && pass.length > 0;
    if (!bearerConfigured && !basicConfigured) return new Response('not configured', { status: 503 });
    if (
      !(bearerConfigured && bearerAuthOk(request, bearer)) &&
      !(basicConfigured && basicAuthOk(request, user, pass))
    ) {
      return unauthorized();
    }

    return mcpHandler.fetch(request, env, ctx);
  },
};
