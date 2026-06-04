import * as playwright from '@cloudflare/playwright';

const browserSessionsByMcpSession = new Map<string, string>();

function endpointFrom(input: string | { endpointURL?: string; wsEndpoint?: string }): string {
  if (typeof input === 'string') return input;
  return input.wsEndpoint ?? input.endpointURL ?? '';
}

function snapshotText(snapshot: unknown): string {
  if (typeof snapshot === 'string') return snapshot;
  if (!snapshot || typeof snapshot !== 'object') return String(snapshot);

  const candidate = snapshot as { full?: unknown; incremental?: unknown; snapshot?: unknown; text?: unknown };
  if (typeof candidate.full === 'string') return candidate.full;
  if (typeof candidate.incremental === 'string') return candidate.incremental;
  if (typeof candidate.snapshot === 'string') return candidate.snapshot;
  if (typeof candidate.text === 'string') return candidate.text;
  return JSON.stringify(snapshot);
}

function patchLocatorCodegen(page: any): void {
  if (typeof page.locator !== 'function') return;
  const locator = page.locator('html');
  const prototype = Object.getPrototypeOf(locator);
  if (typeof prototype._generateLocatorString === 'function') return;
  prototype._generateLocatorString = async function generateLocatorString() {
    if (typeof this._selector === 'string') return `locator(${JSON.stringify(this._selector)})`;
    if (typeof this.toString === 'function') return this.toString();
    throw new Error('Unable to generate locator string');
  };
}

function patchPageSnapshot(page: any): void {
  patchLocatorCodegen(page);
  if (page.__makotoSnapshotPatched || typeof page._snapshotForAI !== 'function') return;
  const originalSnapshotForAI = page._snapshotForAI.bind(page);
  page._snapshotForAI = async (...args: unknown[]) => snapshotText(await originalSnapshotForAI(...args));
  page.__makotoSnapshotPatched = true;
}

function patchContext(context: any): void {
  if (context.__makotoSnapshotPatched || typeof context.newPage !== 'function') return;
  const originalNewPage = context.newPage.bind(context);
  context.newPage = async (...args: unknown[]) => {
    const page = await originalNewPage(...args);
    patchPageSnapshot(page);
    return page;
  };
  for (const page of context.pages?.() ?? []) patchPageSnapshot(page);
  context.__makotoSnapshotPatched = true;
}

function patchBrowser(browser: any): any {
  if (browser.__makotoSnapshotPatched || typeof browser.newContext !== 'function') return browser;
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: unknown[]) => {
    const context = await originalNewContext(...args);
    patchContext(context);
    return context;
  };
  for (const context of browser.contexts?.() ?? []) patchContext(context);
  browser.__makotoSnapshotPatched = true;
  return browser;
}

async function connectOverCDP(input: string | { endpointURL?: string; wsEndpoint?: string }) {
  const endpoint = endpointFrom(input);
  if (!endpoint) throw new Error('No endpointURL or wsEndpoint provided');
  const url = new URL(endpoint);
  const mcpSession = url.searchParams.get('mcp_session') ?? undefined;
  url.searchParams.delete('mcp_session');
  url.searchParams.delete('persistent');
  const browserSession = mcpSession ? browserSessionsByMcpSession.get(mcpSession) : undefined;
  if (browserSession && !url.searchParams.has('browser_session')) {
    url.searchParams.set('browser_session', browserSession);
  }
  if (url.searchParams.has('browser_session') || /^\/v1\/devtools\/browser\/[^/]+$/.test(url.pathname)) {
    try {
      return patchBrowser(await playwright.connect(url.toString()));
    } catch (error) {
      if (!mcpSession) throw error;
      browserSessionsByMcpSession.delete(mcpSession);
      url.searchParams.delete('browser_session');
    }
  }
  const browser = await playwright.launch(url.toString(), { keep_alive: 600_000 });
  const sessionId = browser.sessionId?.();
  if (mcpSession && sessionId) browserSessionsByMcpSession.set(mcpSession, sessionId);
  return patchBrowser(browser);
}

export const chromium = new Proxy(playwright.chromium, {
  get(target, property, receiver) {
    if (property === 'connectOverCDP') return connectOverCDP;
    return Reflect.get(target, property, receiver);
  },
});

export const request = playwright.request;
export const selectors = playwright.selectors;
export const devices = playwright.devices;
export const errors = playwright.errors;
export const endpointURLString = playwright.endpointURLString;
export const connect = playwright.connect;
export const launch = playwright.launch;
export const limits = playwright.limits;
export const sessions = playwright.sessions;
export const history = playwright.history;
export const acquire = playwright.acquire;
