import { connect, launch } from '@cloudflare/playwright';
import type { Browser, Page } from '@cloudflare/playwright';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpAgent } from 'agents/mcp';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type PlaywrightState = {
  browserSessionId?: string;
  lastSnapshot?: string;
  lastScreenshotBytes?: number;
};

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
};

const tools: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    title: 'Navigate',
    description: 'Navigate to a URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    readOnlyHint: false,
  },
  {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Return a compact text snapshot of the current page with element refs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnlyHint: true,
  },
  {
    name: 'browser_take_screenshot',
    title: 'Take screenshot',
    description: 'Capture a screenshot of the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['png', 'jpeg'] },
        filename: { type: 'string' },
      },
      additionalProperties: false,
    },
    readOnlyHint: true,
  },
  {
    name: 'browser_type',
    title: 'Type text',
    description: 'Type text into an element ref returned by browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
        slowly: { type: 'boolean' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
    readOnlyHint: false,
  },
  {
    name: 'browser_click',
    title: 'Click',
    description: 'Click an element ref returned by browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref: { type: 'string' },
        doubleClick: { type: 'boolean' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    readOnlyHint: false,
  },
];

export class PlaywrightMCP extends McpAgent<Cloudflare.Env, PlaywrightState> {
  initialState: PlaywrightState = {};
  private browser: Browser | null = null;
  private page: Page | null = null;
  server = this.createServer();

  async init(): Promise<void> {
    return;
  }

  private kvKey(key: string): string {
    return `playwright-mcp:global:${key}`;
  }

  private async getStored(key: string): Promise<string | undefined> {
    return (await this.env.MAKOTO_KV.get(this.kvKey(key))) ?? undefined;
  }

  private async putStored(key: string, value: string): Promise<void> {
    await this.env.MAKOTO_KV.put(this.kvKey(key), value, { expirationTtl: 600 });
  }

  private createServer(): Server {
    const server = new Server(
      { name: 'Makoto Playwright', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnlyHint,
          destructiveHint: !tool.readOnlyHint,
          openWorldHint: true,
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        switch (request.params.name) {
          case 'browser_navigate':
            return await this.navigate(String(args.url ?? ''));
          case 'browser_snapshot':
            return await this.snapshot();
          case 'browser_take_screenshot':
            return await this.screenshot(args);
          case 'browser_type':
            return await this.type(args);
          case 'browser_click':
            return await this.click(args);
          default:
            return errorResult(`Tool "${request.params.name}" not found`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    });
    return server;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser) {
      const browserSessionId = this.state.browserSessionId ?? (await this.getStored('browserSessionId'));
      if (browserSessionId) {
        console.log('[playwright-mcp] connect browser start');
        this.browser = await connect(this.env.BROWSER, browserSessionId);
        console.log('[playwright-mcp] connect browser ok');
      } else {
        console.log('[playwright-mcp] launch browser start');
        this.browser = await launch(this.env.BROWSER, { keep_alive: 600_000 });
        const sessionId = this.browser.sessionId();
        await this.putStored('browserSessionId', sessionId);
        this.setState({ ...this.state, browserSessionId: sessionId });
        console.log('[playwright-mcp] launch browser ok');
      }
    }
    if (!this.page) {
      const existingPage = this.browser.contexts()[0]?.pages()[0];
      if (existingPage) {
        this.page = existingPage;
      } else {
        console.log('[playwright-mcp] new page start');
        this.page = await this.browser.newPage();
        console.log('[playwright-mcp] new page ok');
      }
    }
    return this.page;
  }

  private async navigate(url: string): Promise<ToolResult> {
    if (!url) return errorResult('url is required');
    const page = await this.ensurePage();
    console.log('[playwright-mcp] goto start');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    console.log('[playwright-mcp] goto ok');
    const snapshot = await this.captureSnapshot(page);
    const screenshot = await page.screenshot({ type: 'png' });
    await this.putStored('lastSnapshot', snapshot);
    await this.putStored('lastScreenshotBytes', String(screenshot.byteLength));
    this.setState({
      ...this.state,
      lastSnapshot: snapshot,
      lastScreenshotBytes: screenshot.byteLength,
    });
    return textResult(`Navigated to ${page.url()}\nPage Title: ${await page.title()}`);
  }

  private async snapshot(): Promise<ToolResult> {
    const storedSnapshot = this.state.lastSnapshot ?? (await this.getStored('lastSnapshot'));
    if (storedSnapshot) return textResult(storedSnapshot);
    const page = await this.ensurePage();
    return textResult(await this.captureSnapshot(page));
  }

  private async captureSnapshot(page: Page): Promise<string> {
    return page.evaluate(() => {
      const lines: string[] = [];
      let index = 0;
      const interactiveSelector = [
        'a',
        'button',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="textbox"]',
        '[contenteditable="true"]',
      ].join(',');
      const labelFor = (element: Element): string => {
        const aria = element.getAttribute('aria-label');
        if (aria) return aria.trim();
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ');
          if (text) return text;
        }
        const placeholder = element.getAttribute('placeholder');
        if (placeholder) return placeholder.trim();
        const value = element.getAttribute('value');
        const text = element.textContent?.replace(/\s+/g, ' ').trim();
        return (text || value || element.getAttribute('name') || element.tagName.toLowerCase()).slice(0, 120);
      };
      const roleFor = (element: Element): string => {
        const role = element.getAttribute('role');
        if (role) return role;
        const tag = element.tagName.toLowerCase();
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') return (element.getAttribute('type') || 'text') === 'submit' ? 'button' : 'textbox';
        if (tag === 'a') return 'link';
        return tag;
      };
      lines.push(`URL: ${location.href}`);
      lines.push(`Title: ${document.title}`);
      const heading = document.querySelector('h1,h2,main');
      if (heading?.textContent?.trim()) {
        lines.push(`Main: ${heading.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      }
      for (const element of Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 80)) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const ref = `e${index++}`;
        element.setAttribute('data-makoto-pw-ref', ref);
        lines.push(`- ${roleFor(element)} "${labelFor(element)}" [ref=${ref}]`);
      }
      return lines.join('\n');
    });
  }

  private async screenshot(args: Record<string, unknown>): Promise<ToolResult> {
    const storedBytes = this.state.lastScreenshotBytes ?? Number((await this.getStored('lastScreenshotBytes')) ?? '');
    if (storedBytes) {
      const type = args.type === 'jpeg' ? 'jpeg' : 'png';
      const filename = typeof args.filename === 'string' && args.filename ? args.filename : `screenshot.${type}`;
      return textResult(`Screenshot of viewport\nSaved: ${filename}\nBytes: ${storedBytes}`);
    }
    const page = await this.ensurePage();
    const type = args.type === 'jpeg' ? 'jpeg' : 'png';
    const filename = typeof args.filename === 'string' && args.filename ? args.filename : `screenshot.${type}`;
    const bytes = await page.screenshot({ type });
    return {
      content: [
        { type: 'text', text: `Screenshot of viewport\nSaved: ${filename}\nBytes: ${bytes.byteLength}` },
      ],
    };
  }

  private async type(args: Record<string, unknown>): Promise<ToolResult> {
    const page = await this.ensurePage();
    const ref = String(args.ref ?? '');
    const text = String(args.text ?? '');
    if (!ref) return errorResult('ref is required');
    const locator = page.locator(`[data-makoto-pw-ref="${cssEscape(ref)}"]`).first();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    try {
      await locator.fill(text, { timeout: 10_000 });
    } catch {
      await locator.click();
      await page.keyboard.type(text);
    }
    if (args.submit === true) await page.keyboard.press('Enter');
    return textResult(`Typed into ref=${ref}`);
  }

  private async click(args: Record<string, unknown>): Promise<ToolResult> {
    const page = await this.ensurePage();
    const ref = String(args.ref ?? '');
    if (!ref) return errorResult('ref is required');
    const locator = page.locator(`[data-makoto-pw-ref="${cssEscape(ref)}"]`).first();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    if (args.doubleClick === true) await locator.dblclick();
    else await locator.click();
    return textResult(`Clicked ref=${ref}`);
  }
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const mcpHandler = PlaywrightMCP.serve('/mcp', { binding: 'PLAYWRIGHT_MCP' });
const sseHandler = PlaywrightMCP.serveSSE('/sse', { binding: 'PLAYWRIGHT_MCP' });

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

    if (url.pathname === '/selftest') {
      return safeBrowserSelftest(env);
    }

    if (url.pathname === '/sse' || url.pathname.startsWith('/sse/')) {
      return sseHandler.fetch(request, env, ctx);
    }
    return mcpHandler.fetch(request, env, ctx);
  },
};
