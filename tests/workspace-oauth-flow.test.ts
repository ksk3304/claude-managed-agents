import { describe, expect, it } from 'vitest';
import {
  handleWorkspaceOAuthCallback,
  handleWorkspaceOAuthStart,
} from '../src/lib/workspace-oauth-flow';
import { getRefreshToken } from '../src/lib/oauth-vault';
import {
  makeFakeOAuthLeaseNamespace,
  makeFetchMock,
  makeMakotoDb,
  TEST_VAULT_KEY_B64,
} from './makoto-helpers';
import { makeKv } from './helpers';

function makeEnv(): Env {
  return {
    MAKOTO_KV: makeKv(),
    DB: makeMakotoDb(),
    MAKOTO_OAUTH_LEASE: makeFakeOAuthLeaseNamespace(),
    OAUTH_VAULT_KEY: TEST_VAULT_KEY_B64,
    OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'client-secret',
    MAKOTO_WORKSPACE_OAUTH_ADMIN_TOKEN: 'operator-token',
  } as unknown as Env;
}

describe('workspace OAuth flow', () => {
  it('start is secret-gated', async () => {
    const env = makeEnv();
    const res = await handleWorkspaceOAuthStart(
      new Request('https://worker.example/oauth/google/workspace/start?user_slug=k-seto'),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('start redirects to Google with Worker callback URL and full Workspace scopes', async () => {
    const env = makeEnv();
    const res = await handleWorkspaceOAuthStart(
      new Request(
        'https://worker.example/oauth/google/workspace/start?token=operator-token&user_slug=k-seto',
      ),
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    const google = new URL(location!);
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('redirect_uri')).toBe(
      'https://worker.example/oauth/google/workspace/callback',
    );
    expect(google.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar');
    expect(google.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(google.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/documents');
    expect(google.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive');
  });

  it('callback exchanges code and stores refresh_token in the per-user vault', async () => {
    const env = makeEnv();
    const start = await handleWorkspaceOAuthStart(
      new Request(
        'https://worker.example/oauth/google/workspace/start?token=operator-token&user_slug=k-seto',
      ),
      env,
    );
    const google = new URL(start.headers.get('location')!);
    const state = google.searchParams.get('state')!;
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(init.body as string);
      expect(params.get('code')).toBe('google-code');
      expect(params.get('redirect_uri')).toBe(
        'https://worker.example/oauth/google/workspace/callback',
      );
      return Response.json({
        access_token: 'access-token',
        expires_in: 3600,
        refresh_token: 'refresh-token-new',
      });
    });

    const res = await handleWorkspaceOAuthCallback(
      new Request(
        `https://worker.example/oauth/google/workspace/callback?state=${state}&code=google-code`,
      ),
      env,
      fetchImpl,
    );

    expect(res.status).toBe(200);
    await expect(getRefreshToken(env.MAKOTO_KV, TEST_VAULT_KEY_B64, 'k-seto')).resolves.toBe(
      'refresh-token-new',
    );
    expect((env.DB as unknown as { _tables: { oauth_audit: unknown[] } })._tables.oauth_audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_slug: 'k-seto',
          action: 'bootstrap',
          outcome: 'success',
        }),
      ]),
    );
  });

  it('uses the Access-bypassed webhooks callback when started under /webhooks', async () => {
    const env = makeEnv();
    const res = await handleWorkspaceOAuthStart(
      new Request(
        'https://worker.example/webhooks/oauth/google/workspace/start?token=operator-token&user_slug=k-seto',
      ),
      env,
    );
    expect(res.status).toBe(302);
    const google = new URL(res.headers.get('location')!);
    expect(google.searchParams.get('redirect_uri')).toBe(
      'https://worker.example/webhooks/oauth/google/workspace/callback',
    );
  });
});
