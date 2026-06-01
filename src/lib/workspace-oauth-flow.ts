import { getOAuthLease } from '../durable-objects/oauth-lease';
import { assertBridgeEgressAllowed } from './egress-guard';
import { bootstrapUser } from './workspace-oauth';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';

const STATE_PREFIX = 'oauth:workspace:state';
const DEVICE_PREFIX = 'oauth:workspace:device';
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

interface GoogleDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_url?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface WorkspaceDeviceState {
  state: string;
  user_slug: string;
  device_code: string;
  user_code: string;
  verification_url: string;
  scopes: string[];
  created_at_ms: number;
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

export async function handleWorkspaceOAuthDeviceStart(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = defaultFetch,
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
  let device: GoogleDeviceCodeResponse;
  try {
    device = await requestDeviceCode({
      clientId: requireOAuthClientId(env),
      scopes: resolveWorkspaceOAuthScopes(env),
      fetchImpl,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  if (!device.device_code || !device.user_code || !(device.verification_url || device.verification_uri)) {
    return Response.json({ ok: false, error: 'Google device response malformed' }, { status: 500 });
  }
  const state = crypto.randomUUID();
  const scopes = resolveWorkspaceOAuthScopes(env);
  const verificationUrl = device.verification_url || device.verification_uri || '';
  const entry: WorkspaceDeviceState = {
    state,
    user_slug: userSlug,
    device_code: device.device_code,
    user_code: device.user_code,
    verification_url: verificationUrl,
    scopes,
    created_at_ms: Date.now(),
  };
  await env.MAKOTO_KV.put(deviceKey(state), JSON.stringify(entry), {
    expirationTtl: Math.min(Math.max(device.expires_in ?? STATE_TTL_SECONDS, 60), 1800),
  });
  return Response.json({
    ok: true,
    state,
    user_code: device.user_code,
    verification_url: verificationUrl,
    verification_uri: verificationUrl,
    expires_in: device.expires_in,
    interval: device.interval,
    poll_url: `${url.origin}/webhooks/oauth/google/workspace/device/poll?token=${encodeURIComponent(adminToken)}&state=${encodeURIComponent(state)}`,
  });
}

export async function handleWorkspaceOAuthDevicePoll(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<Response> {
  const url = new URL(request.url);
  const adminToken = resolveWorkspaceOAuthAdminToken(env);
  if (!adminToken) return new Response('not found', { status: 404 });
  if ((url.searchParams.get('token') ?? '') !== adminToken) {
    return new Response('not found', { status: 404 });
  }
  const state = url.searchParams.get('state') ?? '';
  if (!state) return Response.json({ ok: false, error: 'missing state' }, { status: 400 });
  const raw = await env.MAKOTO_KV.get(deviceKey(state));
  if (!raw) return Response.json({ ok: false, error: 'device state expired' }, { status: 400 });
  const entry = JSON.parse(raw) as WorkspaceDeviceState;
  let token: GoogleTokenResponse;
  try {
    token = await pollDeviceToken({
      deviceCode: entry.device_code,
      clientId: requireOAuthClientId(env),
      clientSecret: requireOAuthClientSecret(env),
      fetchImpl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('authorization_pending') || message.includes('slow_down')) {
      return Response.json({ ok: false, pending: true, error: message }, { status: 202 });
    }
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
  if (!token.refresh_token) {
    return Response.json({ ok: false, error: 'Google did not return refresh_token' }, { status: 400 });
  }
  await env.MAKOTO_KV.delete(deviceKey(state));
  await storeWorkspaceRefreshToken(env, entry.user_slug, token.refresh_token, entry.scopes, fetchImpl);
  return Response.json({ ok: true, user_slug: entry.user_slug, scope: token.scope ?? '' });
}

export async function handleWorkspaceOAuthCallback(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = defaultFetch,
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

  await storeWorkspaceRefreshToken(env, entry.user_slug, token.refresh_token, entry.scopes, fetchImpl);

  return oauthHtml(
    `Workspace OAuth registered for ${escapeHtml(entry.user_slug)}. You can close this tab.`,
    200,
  );
}

async function requestDeviceCode(input: {
  clientId: string;
  scopes: string[];
  fetchImpl: typeof fetch;
}): Promise<GoogleDeviceCodeResponse> {
  assertBridgeEgressAllowed(GOOGLE_DEVICE_CODE_URL, 'workspace-oauth:device-code');
  const resp = await input.fetchImpl(GOOGLE_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      scope: input.scopes.join(' '),
    }).toString(),
  });
  const body = (await resp.json().catch(() => ({}))) as GoogleDeviceCodeResponse;
  if (!resp.ok) {
    const msg = body.error_description || body.error || `HTTP ${resp.status}`;
    throw new Error(`Google device code failed: ${msg}`);
  }
  return body;
}

async function pollDeviceToken(input: {
  deviceCode: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: typeof fetch;
}): Promise<GoogleTokenResponse> {
  assertBridgeEgressAllowed(GOOGLE_TOKEN_URL, 'workspace-oauth:device-token');
  const resp = await input.fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      device_code: input.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString(),
  });
  const body = (await resp.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!resp.ok) {
    const msg = body.error_description || body.error || `HTTP ${resp.status}`;
    throw new Error(`Google device token failed: ${msg}`);
  }
  return body;
}

async function storeWorkspaceRefreshToken(
  env: Env,
  userSlug: string,
  refreshToken: string,
  scopes: string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const lease = getOAuthLease(env, userSlug);
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
    userSlug,
    refreshToken,
    {
      callerSessionId: 'workspace-oauth-callback',
      notes: `cloudflare_callback scopes=${scopes.join(',')}`,
    },
  );
  await lease.invalidate({
    userSlug,
    callerSessionId: 'workspace-oauth-callback',
    reason: 'workspace_oauth_reauthorized',
  });
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

function deviceKey(state: string): string {
  return `${DEVICE_PREFIX}:${state}`;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

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
