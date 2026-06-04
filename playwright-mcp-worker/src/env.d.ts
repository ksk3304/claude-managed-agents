declare namespace Cloudflare {
  interface Env {
    BROWSER: import('@cloudflare/playwright').BrowserWorker;
    MAKOTO_KV: KVNamespace;
    PLAYWRIGHT_MCP: DurableObjectNamespace;
    MCP_BEARER_TOKEN?: string;
    MCP_BASIC_USER?: string;
    MCP_BASIC_PASS?: string;
  }
}
