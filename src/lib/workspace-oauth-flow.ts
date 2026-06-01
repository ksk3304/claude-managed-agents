import { getOAuthLease } from '../durable-objects/oauth-lease';
import { assertBridgeEgressAllowed } from './egress-guard';
import { bootstrapUser } from './workspace-oauth';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const STATE_PREFIX = 'oauth:workspace:state';
const STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
];

interface WorkspaceOAuthState {
  state: string;
  user_slug: string;
  redirect_uri: string;
  scopes: string[];
  created_at_ms: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function handleWorkspaceOAuthStart(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const adminToken = resolveWorkspaceOAuthAdminToken(env);
  if (!adminToken) return new Response('not found', { status: 404 });
  if ((url.searchParams.get('token') ?? '') !== adminToken) {
    return new Response('not found', { status: 404 });
  }
  const userSlug = url.searchParams.get('user_slug') ?? env.DEFAULT_USER_SLUG ?? '';
  if (!isValidUserSlug(userSlug)) {
    return Response.json({ ok: false, error: 'invalid user_slug' }, { status: 400 });
  }
  const scopes = resolveWorkspaceOAuthScopes(env);
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}${workspaceOAuthCallbackPath(url.pathname)}`;
  const entry: WorkspaceOAuthState = {
    state,
    user_slug: userSlug,
    redirect_uri: redirectUri,
    scopes,
    created_at_ms: Date.now(),
  };
  await env.MAKOTO_KV.put(stateKey(state), JSON.stringify(entry), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const auth = new URL(GOOGLE_AUTHORIZE_URL);
  auth.searchParams.set('client_id', requireOAuthClientId(env));
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', scopes.join(' '));
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('include_granted_scopes', 'true');
  auth.searchParams.set('state', state);
  return Response.redirect(auth.toString(), 302);
}

export async function handleWorkspaceOAuthCallback(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const error = url.searchParams.get('error') ?? '';
  if (error) return oauthHtml(`Google OAuth error: ${escapeHtml(error)}`, 400);
  if (!state || !code) return oauthHtml('Missing OAuth state or code.', 400);

  const raw = await env.MAKOTO_KV.get(stateKey(state));
  if (!raw) return oauthHtml('OAuth state expired. Start again.', 400);
  await env.MAKOTO_KV.delete(stateKey(state));
  const entry = JSON.parse(raw) as WorkspaceOAuthState;
  if (entry.state !== state || !isValidUserSlug(entry.user_slug)) {
    return oauthHtml('Invalid OAuth state.', 400);
  }
  const callbackUrl = `${url.origin}${url.pathname}`;
  if (entry.redirect_uri !== callbackUrl) {
    return oauthHtml('OAuth callback URL mismatch.', 400);
  }

  let token: GoogleTokenResponse;
  try {
    token = await exchangeCodeForToken({
      code,
      redirectUri: entry.redirect_uri,
      clientId: requireOAuthClientId(env),
      clientSecret: requireOAuthClientSecret(env),
      fetchImpl,
    });
  } catch (err) {
    return oauthHtml(escapeHtml(err instanceof Error ? err.message : String(err)), 500);
  }
  if (!token.refresh_token) {
    return oauthHtml('Google did not return refresh_token. Revoke app access and retry.', 400);
  }

  const lease = getOAuthLease(env, entry.user_slug);
  await bootstrapUser(
    {
      db: env.DB,
      kv: env.MAKOTO_KV,
      vaultKeyB64: requireVaultKey(env),
      clientId: requireOAuthClientId(env),
      clientSecret: requireOAuthClientSecret(env),
      oauthLease: lease,
      fetchImpl,
    },
    entry.user_slug,
    token.refresh_token,
    {
      callerSessionId: 'workspace-oauth-callback',
      notes: `cloudflare_callback scopes=${entry.scopes.join(',')}`,
    },
  );
  await lease.invalidate({
    userSlug: entry.user_slug,
    callerSessionId: 'workspace-oauth-callback',
    reason: 'workspace_oauth_reauthorized',
  });

  return oauthHtml(
    `Workspace OAuth registered for ${escapeHtml(entry.user_slug)}. You can close this tab.`,
    200,
  );
}

async function exchangeCodeForToken(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
}): Promise<GoogleTokenResponse> {
  assertBridgeEgressAllowed(GOOGLE_TOKEN_URL, 'workspace-oauth:code-exchange');
  const resp = await input.fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const text = await resp.text();
  let body: GoogleTokenResponse;
  try {
    body = JSON.parse(text) as GoogleTokenResponse;
  } catch {
    body = { error: 'invalid_json', error_description: text.slice(0, 200) };
  }
  if (!resp.ok) {
    const msg = body.error_description || body.error || `HTTP ${resp.status}`;
    throw new Error(`Google token exchange failed: ${msg}`);
  }
  return body;
}

function resolveWorkspaceOAuthAdminToken(env: Env): string {
  return (
    env.MAKOTO_WORKSPACE_OAUTH_ADMIN_TOKEN ||
    env.MAKOTO_DEBUG_TOKEN ||
    ''
  ).trim();
}

function resolveWorkspaceOAuthScopes(env: Env): string[] {
  const raw = (env.WORKSPACE_OAUTH_SCOPES || '').trim();
  if (!raw) return DEFAULT_SCOPES;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function requireVaultKey(env: Env): string {
  if (!env.OAUTH_VAULT_KEY) throw new Error('OAUTH_VAULT_KEY is not set');
  return env.OAUTH_VAULT_KEY;
}

function requireOAuthClientId(env: Env): string {
  if (!env.OAUTH_CLIENT_ID) throw new Error('OAUTH_CLIENT_ID is not set');
  return env.OAUTH_CLIENT_ID;
}

function requireOAuthClientSecret(env: Env): string {
  if (!env.OAUTH_CLIENT_SECRET) throw new Error('OAUTH_CLIENT_SECRET is not set');
  return env.OAUTH_CLIENT_SECRET;
}

function stateKey(state: string): string {
  return `${STATE_PREFIX}:${state}`;
}

function isValidUserSlug(value: string): boolean {
  return /^[a-z0-9_-]{1,64}$/.test(value);
}

function workspaceOAuthCallbackPath(startPath: string): string {
  return startPath.startsWith('/webhooks/')
    ? '/webhooks/oauth/google/workspace/callback'
    : '/oauth/google/workspace/callback';
}

function oauthHtml(message: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>MAKOTO OAuth</title><body>${message}</body>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}
