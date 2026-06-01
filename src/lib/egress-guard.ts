/**
 * MAKOTO bridge — egress hard-allowlist.
 *
 * cma-on-cf's existing `EGRESS_POLICIES` KV / `resolveSessionPolicy`
 * pipeline is built for the Sandbox / Isolate session backends — it
 * enforces outbound rules *inside* a sandboxed container. The MAKOTO
 * bridge path doesn't go through that pipeline: `agentmail-dispatch.ts`
 * calls Anthropic / AgentMail / Google APIs directly from the Worker.
 *
 * To honour plan-draft §step 10 ("egress allowlist for the bridge") we
 * gate every outbound `fetch()` the bridge issues on a hard-coded
 * allowlist of hostnames. Any URL whose host isn't on the list throws
 * `BridgeEgressDeniedError` *before* the network call goes out — so a
 * mis-configured tool or a future drift can't quietly add a new
 * dependency.
 *
 * Wired callers:
 *   - `tool-common.ts:googleApiFetch` (all Drive / Sheets / Calendar tools)
 *   - `agentmail-api.ts:AgentMailClient` (AgentMail REST)
 *   - `workspace-oauth.ts` (Google OAuth refresh / revoke)
 *
 * Anthropic SDK calls (`client.beta.sessions.*`) bypass this guard
 * because the SDK encapsulates its own `fetch()`; we instead rely on
 * `buildAnthropicClient` / `resolveAnthropicBaseURL` pinning the base
 * URL to `api.anthropic.com` (or an `ANTHROPIC_BASE_URL` override the
 * operator explicitly set). The allowlist still records the Anthropic
 * host so operators auditing the bridge see the complete dependency set.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 — 層 8 残)
 * Spec: plan-draft.md §step 10 + R8 (egress policy 設定漏れ)
 */

/**
 * Hosts the MAKOTO bridge is allowed to call directly from the Worker.
 * Subdomains are NOT honoured automatically — each FQDN is matched
 * verbatim against `URL.hostname` after lowercasing.
 *
 * Adding a new host = a deliberate change here. Drift-prone behaviour
 * (e.g. tools that gradually call sibling Google APIs) is exactly what
 * this allowlist exists to surface.
 */
export const MAKOTO_BRIDGE_EGRESS_ALLOWLIST: readonly string[] = [
  // Anthropic — sessions, events, streams (SDK-mediated; recorded for audit).
  'api.anthropic.com',
  // AgentMail REST — send / reply / get / list inbound messages.
  'api.agentmail.to',
  // Google OAuth — refresh + revoke + SA JWT token exchange.
  'oauth2.googleapis.com',
  // Cloud Scheduler — bot から CRUD のみ (Issue #186 SCHEDULE_ACTION dispatch)。
  'cloudscheduler.googleapis.com',
  // Google Drive / Sheets / Docs / Calendar / Chat APIs — base + upload subdomain.
  'www.googleapis.com',
  'sheets.googleapis.com',
  'docs.googleapis.com',
  'calendar.googleapis.com',
  'drive.googleapis.com',
  // Google Chat REST API (MAKOTOくん bot POST + thread replies, Issue #186 Phase 2).
  'chat.googleapis.com',
];

const ALLOWED_SET: ReadonlySet<string> = new Set(
  MAKOTO_BRIDGE_EGRESS_ALLOWLIST.map((h) => h.toLowerCase()),
);

export class BridgeEgressDeniedError extends Error {
  readonly host: string;
  readonly callerHint: string | undefined;

  constructor(host: string, callerHint?: string) {
    const where = callerHint ? ` (caller=${callerHint})` : '';
    super(
      `MAKOTO bridge egress denied: host=${host} not in allowlist${where}. ` +
        `Add to MAKOTO_BRIDGE_EGRESS_ALLOWLIST in src/lib/egress-guard.ts ` +
        `after auditing the new dependency.`,
    );
    this.name = 'BridgeEgressDeniedError';
    this.host = host;
    if (callerHint !== undefined) this.callerHint = callerHint;
  }
}

/**
 * Throw `BridgeEgressDeniedError` if `url`'s host isn't in the
 * allowlist. Call from every bridge-side fetch call site before the
 * network request is dispatched.
 *
 * `callerHint` is included in the error message so the stack trace
 * isn't the only clue when a tool gets denied — pass the tool name or
 * the module identifier (e.g. `'agentmail-api:sendMessage'`).
 *
 * Throws `BridgeEgressDeniedError` on a parse-failed URL too — better
 * to fail loudly on a malformed url than to send a request to a host
 * we can't validate.
 */
export function assertBridgeEgressAllowed(url: string, callerHint?: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeEgressDeniedError(`<unparseable:${url.slice(0, 80)}>`, callerHint);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_SET.has(host)) {
    throw new BridgeEgressDeniedError(host, callerHint);
  }
}
