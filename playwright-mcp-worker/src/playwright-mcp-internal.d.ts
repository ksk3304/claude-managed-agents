declare module '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/index.js' {
  import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

  export interface PlaywrightMcpConnection {
    server: Server;
    close(): Promise<void>;
  }

  export function createConnection(userConfig?: unknown): Promise<PlaywrightMcpConnection>;
}
