import { launch } from '@cloudflare/playwright';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { DurableObject } from 'cloudflare:workers';

import { createConnection } from './patched-playwright-mcp';

type McpConnection = Awaited<ReturnType<typeof createConnection>>;

const MCP_CAPABILITIES = ['core', 'tabs', 'history', 'wait', 'files'] as const;
const DEFAULT_SESSION_ID = 'makoto-agent-default';

class DurableSseTransport {
  readonly sessionId: string;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private started = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: { requestInfo?: { headers: Headers; url: URL } }) => void;

  constructor(sessionId: string, writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.sessionId = sessionId;
    this.writer = writer;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Transport already started');
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started) throw new Error('Transport not started');
    await this.writer.write(this.encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  }

  async receive(request: Request): Promise<void> {
    let parsed: JSONRPCMessage;
    try {
      parsed = JSONRPCMessageSchema.parse(await request.json());
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(err);
      throw err;
    }
    this.onmessage?.(parsed, { requestInfo: { headers: request.headers, url: new URL(request.url) } });
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // Stream may already be closed by the client.
    }
    this.onclose?.();
  }
}

export class PlaywrightMCP extends DurableObject<Cloudflare.Env> {
  private connection?: McpConnection;
  private transport?: DurableSseTransport;
  private sessionId?: string;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/sse/connect') {
      return this.openSse(request);
    }
    if (request.method === 'POST' && url.pathname === '/sse/message') {
      return this.postMessage(request);
    }
    return new Response('not found', { status: 404 });
  }

  private async openSse(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? DEFAULT_SESSION_ID;
    await this.connection?.server.close().catch(() => undefined);

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const endpointUrl = new URL(request.url);
    endpointUrl.pathname = '/sse/message';
    endpointUrl.searchParams.set('sessionId', sessionId);
    void writer.write(encoder.encode(`event: endpoint\ndata: ${endpointUrl.pathname + endpointUrl.search}\n\n`)).catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.transport?.onerror?.(err);
    });

    this.sessionId = sessionId;
    this.transport = new DurableSseTransport(sessionId, writer);
    this.connection ??= await createConnection({
      capabilities: MCP_CAPABILITIES,
      browser: {
        cdpEndpoint: launchEndpoint(this.env, sessionId),
        isolated: true,
      },
    });
    await this.connection.server.connect(this.transport as any);

    return new Response(readable, {
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      },
    });
  }

  private async postMessage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId || sessionId !== this.sessionId || !this.transport) {
      return new Response('SSE connection not established', { status: 500 });
    }
    await this.transport.receive(request);
    return new Response('Accepted', {
      status: 202,
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      },
    });
  }
}

function launchEndpoint(env: Cloudflare.Env, mcpSessionId: string): string {
  const bindingKey = Object.keys(env).find((key) => env[key as keyof Cloudflare.Env] === env.BROWSER);
  if (!bindingKey) throw new Error('No BROWSER binding found');
  const url = new URL('http://fake.host/v1/devtools/browser');
  url.searchParams.set('browser_binding', bindingKey);
  url.searchParams.set('mcp_session', mcpSessionId);
  return url.toString();
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': '*',
  };
}

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

async function runBrowserSelftest(env: Cloudflare.Env): Promise<Response> {
  const marker = 'MAKOTO-PLAYWRIGHT-MCP-SELFTEST';
  const browser = await launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(
      `data:text/html;charset=utf-8,<!doctype html><title>selftest</title><main>${marker}</main>`,
      { waitUntil: 'domcontentloaded' },
    );
    const title = await page.title();
    const text = await page.locator('main').textContent();
    const screenshot = await page.screenshot({ type: 'png' });
    await page.close();
    return Response.json({
      ok: title === 'selftest' && text === marker && screenshot.byteLength > 0,
      title,
      text,
      screenshotBytes: screenshot.byteLength,
    });
  } finally {
    await browser.close();
  }
}

async function safeBrowserSelftest(env: Cloudflare.Env): Promise<Response> {
  try {
    return await runBrowserSelftest(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return Response.json({ ok: false, error: message, stack }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'makoto-playwright-mcp', implementation: 'official-direct-sse' });
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

    if (url.pathname === '/selftest') {
      return safeBrowserSelftest(env);
    }

    if (url.pathname === '/sse' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? DEFAULT_SESSION_ID;
      const id = env.PLAYWRIGHT_MCP.idFromName(`sse:${sessionId}`);
      const connectUrl = new URL(request.url);
      connectUrl.pathname = '/sse/connect';
      connectUrl.searchParams.set('sessionId', sessionId);
      return env.PLAYWRIGHT_MCP.get(id).fetch(new Request(connectUrl, request));
    }

    if (url.pathname === '/sse/message' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return new Response('Missing sessionId', { status: 400 });
      const id = env.PLAYWRIGHT_MCP.idFromName(`sse:${sessionId}`);
      return env.PLAYWRIGHT_MCP.get(id).fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
};
