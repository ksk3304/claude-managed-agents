/**
 * Test helpers specific to the MAKOTO bridge (Issue #186).
 *
 * Kept separate from `tests/helpers.ts` so the existing cma-on-cf test
 * helpers stay focused on the upstream Sandbox / Isolate / egress
 * surfaces. The MAKOTO bridge adds:
 *
 *   - dedupe table (claim / lease_version / committed_at fence)
 *   - oauth_audit table (per-user OAuth audit rows)
 *   - agentmail_webhook_seen table (svix-id transport dedupe)
 *   - sent_messages.rfc822_msgid column (extension of an existing table)
 *
 * The fake D1 below recognises just the SQL the MAKOTO bridge issues —
 * unrecognised SQL throws so a typo in production code surfaces loudly
 * in tests rather than silently no-op'ing.
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { makeKv } from './helpers';

// ---------------------------------------------------------------------------
// MAKOTO bridge fake D1
// ---------------------------------------------------------------------------

interface FakeRow {
  [k: string]: unknown;
}

interface MakotoTables {
  dedupe: Map<string, FakeRow>;
  oauth_audit: FakeRow[];
  agentmail_webhook_seen: Map<string, FakeRow>;
  cma_session_binds: Map<string, FakeRow>;
  cma_session_payload_audit: Map<string, FakeRow>;
  cma_worker_runtime_events: Map<string, FakeRow>;
  sent_messages: Map<string, FakeRow>;
  email_threads: Map<string, FakeRow>;
  sessions: Map<string, FakeRow>;
  agent_emails: Map<string, FakeRow>;
}

export function makeMakotoDb(): D1Database & { _tables: MakotoTables } {
  const tables: MakotoTables = {
    dedupe: new Map(),
    oauth_audit: [],
    agentmail_webhook_seen: new Map(),
    cma_session_binds: new Map(),
    cma_session_payload_audit: new Map(),
    cma_worker_runtime_events: new Map(),
    sent_messages: new Map(),
    email_threads: new Map(),
    sessions: new Map(),
    agent_emails: new Map(),
  };

  function exec(
    sql: string,
    params: unknown[],
  ): { results: FakeRow[]; meta?: { changes: number } } {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    // ----- dedupe -----
    if (/^SELECT committed_at_ms FROM dedupe WHERE event_key = \?$/i.test(trimmed)) {
      const [key] = params as [string];
      const row = tables.dedupe.get(key);
      return { results: row ? [{ committed_at_ms: row.committed_at_ms ?? null }] : [] };
    }
    if (
      /^INSERT OR IGNORE INTO dedupe \(event_key, claim_state, claim_owner, lease_version, lease_expires_at_ms, committed_at_ms, created_at_ms, ttl_expires_at_ms\) VALUES \(\?1, 'NEW', \?2, 1, \?3, NULL, \?4, \?5\)$/i.test(
        trimmed,
      )
    ) {
      const [key, owner, leaseExp, now, ttlExp] = params as [string, string, number, number, number];
      if (tables.dedupe.has(key)) {
        return { results: [], meta: { changes: 0 } };
      }
      tables.dedupe.set(key, {
        event_key: key,
        claim_state: 'NEW',
        claim_owner: owner,
        lease_version: 1,
        lease_expires_at_ms: leaseExp,
        committed_at_ms: null,
        created_at_ms: now,
        ttl_expires_at_ms: ttlExp,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (
      /^UPDATE dedupe SET claim_state = 'TAKEOVER', claim_owner = \?2, lease_version = lease_version \+ 1, lease_expires_at_ms = \?3 WHERE event_key = \?1 AND committed_at_ms IS NULL AND lease_expires_at_ms < \?4$/i.test(
        trimmed,
      )
    ) {
      const [key, owner, leaseExp, now] = params as [string, string, number, number];
      const row = tables.dedupe.get(key);
      if (!row || row.committed_at_ms !== null) return { results: [], meta: { changes: 0 } };
      if (Number(row.lease_expires_at_ms) >= Number(now)) return { results: [], meta: { changes: 0 } };
      row.claim_state = 'TAKEOVER';
      row.claim_owner = owner;
      row.lease_version = Number(row.lease_version) + 1;
      row.lease_expires_at_ms = leaseExp;
      return { results: [], meta: { changes: 1 } };
    }
    if (/^SELECT lease_version FROM dedupe WHERE event_key = \?$/i.test(trimmed)) {
      const [key] = params as [string];
      const row = tables.dedupe.get(key);
      return { results: row ? [{ lease_version: row.lease_version }] : [] };
    }
    if (
      /^UPDATE dedupe SET lease_expires_at_ms = \?3 WHERE event_key = \?1 AND claim_owner = \?2 AND lease_version = \?4 AND committed_at_ms IS NULL$/i.test(
        trimmed,
      )
    ) {
      const [key, owner, leaseExp, version] = params as [string, string, number, number];
      const row = tables.dedupe.get(key);
      if (!row || row.committed_at_ms !== null) return { results: [], meta: { changes: 0 } };
      if (row.claim_owner !== owner || Number(row.lease_version) !== Number(version)) {
        return { results: [], meta: { changes: 0 } };
      }
      row.lease_expires_at_ms = leaseExp;
      return { results: [], meta: { changes: 1 } };
    }
    if (
      /^SELECT claim_owner, lease_version, committed_at_ms FROM dedupe WHERE event_key = \?$/i.test(trimmed)
    ) {
      const [key] = params as [string];
      const row = tables.dedupe.get(key);
      return {
        results: row
          ? [
              {
                claim_owner: row.claim_owner,
                lease_version: row.lease_version,
                committed_at_ms: row.committed_at_ms ?? null,
              },
            ]
          : [],
      };
    }
    if (
      /^UPDATE dedupe SET committed_at_ms = \?2 WHERE event_key = \?1 AND claim_owner = \?3 AND lease_version = \?4 AND committed_at_ms IS NULL$/i.test(
        trimmed,
      )
    ) {
      const [key, now, owner, version] = params as [string, number, string, number];
      const row = tables.dedupe.get(key);
      if (!row || row.committed_at_ms !== null) return { results: [], meta: { changes: 0 } };
      if (row.claim_owner !== owner || Number(row.lease_version) !== Number(version)) {
        return { results: [], meta: { changes: 0 } };
      }
      row.committed_at_ms = now;
      return { results: [], meta: { changes: 1 } };
    }
    if (
      /^UPDATE dedupe SET lease_expires_at_ms = 0 WHERE event_key = \?1 AND claim_owner = \?2 AND lease_version = \?3 AND committed_at_ms IS NULL$/i.test(
        trimmed,
      )
    ) {
      const [key, owner, version] = params as [string, string, number];
      const row = tables.dedupe.get(key);
      if (!row || row.committed_at_ms !== null) return { results: [], meta: { changes: 0 } };
      if (row.claim_owner !== owner || Number(row.lease_version) !== Number(version)) {
        return { results: [], meta: { changes: 0 } };
      }
      row.lease_expires_at_ms = 0;
      return { results: [], meta: { changes: 1 } };
    }
    if (/^DELETE FROM dedupe WHERE ttl_expires_at_ms < \?$/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [k, row] of tables.dedupe) {
        if (Number(row.ttl_expires_at_ms) < Number(cutoff)) {
          tables.dedupe.delete(k);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    // ----- oauth_audit -----
    if (/^INSERT INTO oauth_audit/i.test(trimmed)) {
      const [timestamp_ms, user_slug, caller_session_id, action, outcome, notes] = params as [
        number,
        string,
        string | null,
        string,
        string,
        string | null,
      ];
      tables.oauth_audit.push({
        timestamp_ms,
        user_slug,
        caller_session_id,
        action,
        outcome,
        notes,
      });
      return { results: [], meta: { changes: 1 } };
    }

    // ----- agentmail_webhook_seen -----
    if (/^INSERT OR IGNORE INTO agentmail_webhook_seen/i.test(trimmed)) {
      const [svix_id, received_at_ms, ttl_expires_at_ms] = params as [string, number, number];
      if (tables.agentmail_webhook_seen.has(svix_id)) return { results: [], meta: { changes: 0 } };
      tables.agentmail_webhook_seen.set(svix_id, { svix_id, received_at_ms, ttl_expires_at_ms });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^DELETE FROM agentmail_webhook_seen WHERE ttl_expires_at_ms < \?$/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [k, row] of tables.agentmail_webhook_seen) {
        if (Number(row.ttl_expires_at_ms) < Number(cutoff)) {
          tables.agentmail_webhook_seen.delete(k);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    // ----- cma observability (#202) -----
    if (/^INSERT INTO cma_session_binds /i.test(trimmed)) {
      const [
        id,
        created_at_ms,
        session_key_hash,
        session_id,
        event_key,
        message_id,
        user_slug,
        space_name_hash,
        thread_name_hash,
        is_new_session,
      ] = params as [
        string,
        number,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ];
      tables.cma_session_binds.set(id, {
        id,
        created_at_ms,
        session_key_hash,
        session_id,
        event_key,
        message_id,
        user_slug,
        space_name_hash,
        thread_name_hash,
        is_new_session,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^INSERT INTO cma_session_payload_audit /i.test(trimmed)) {
      const [
        id,
        created_at_ms,
        expire_at_ms,
        session_id,
        event_key,
        message_id,
        user_slug,
        session_key_hash,
        payload_json,
        payload_chars,
      ] = params as [
        string,
        number,
        number,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        number,
      ];
      tables.cma_session_payload_audit.set(id, {
        id,
        created_at_ms,
        expire_at_ms,
        session_id,
        event_key,
        message_id,
        user_slug,
        session_key_hash,
        payload_json,
        payload_chars,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^INSERT INTO cma_worker_runtime_events /i.test(trimmed)) {
      const [
        id,
        created_at_ms,
        expire_at_ms,
        event_key,
        session_id,
        message_id,
        user_slug,
        event_type,
        level,
        source,
        detail_json,
        detail_chars,
      ] = params as [
        string,
        number,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string | null,
        string | null,
        number,
      ];
      tables.cma_worker_runtime_events.set(id, {
        id,
        created_at_ms,
        expire_at_ms,
        event_key,
        session_id,
        message_id,
        user_slug,
        event_type,
        level,
        source,
        detail_json,
        detail_chars,
      });
      return { results: [], meta: { changes: 1 } };
    }

    // ----- sent_messages (with rfc822_msgid extension) -----
    if (
      /^INSERT OR REPLACE INTO sent_messages \(message_id, session_id, agent_id, to_addr, sent_at_ms, rfc822_msgid\) VALUES \(\?1, \?2, \?3, \?4, \?5, \?6\)$/i.test(
        trimmed,
      )
    ) {
      const [message_id, session_id, agent_id, to_addr, sent_at_ms, rfc822] = params as [
        string,
        string,
        string,
        string,
        number,
        string | null,
      ];
      tables.sent_messages.set(message_id, {
        message_id,
        session_id,
        agent_id,
        to_addr,
        sent_at_ms,
        rfc822_msgid: rfc822 ?? null,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (
      /^SELECT session_id, agent_id FROM sent_messages WHERE rfc822_msgid = \?$/i.test(trimmed)
    ) {
      const [rfc822] = params as [string];
      for (const row of tables.sent_messages.values()) {
        if (row.rfc822_msgid === rfc822) {
          return { results: [{ session_id: row.session_id, agent_id: row.agent_id }] };
        }
      }
      return { results: [] };
    }

    // ----- email_threads (passthrough from existing helpers) -----
    if (
      /^SELECT session_id FROM email_threads WHERE agent_id = \?1 AND counterparty = \?2/i.test(trimmed)
    ) {
      const [agent_id, counterparty] = params as [string, string];
      const key = `${agent_id}\x00${counterparty}`;
      const row = tables.email_threads.get(key);
      return { results: row ? [{ session_id: row.session_id }] : [] };
    }
    if (/^INSERT INTO email_threads .*ON CONFLICT/i.test(trimmed)) {
      const [agent_id, counterparty, session_id, last_message_at_ms] = params as [
        string,
        string,
        string,
        number,
      ];
      const key = `${agent_id}\x00${counterparty}`;
      tables.email_threads.set(key, {
        agent_id,
        counterparty,
        session_id,
        last_message_at_ms,
      });
      return { results: [], meta: { changes: 1 } };
    }

    throw new Error(`makoto-fake-db: unrecognised SQL: ${trimmed}`);
  }

  const db = {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params.push(...args);
          return stmt;
        },
        async run() {
          return exec(sql, params);
        },
        async all<T>() {
          return exec(sql, params) as { results: T[] };
        },
        async first<T>() {
          const r = exec(sql, params);
          return (r.results[0] as T) ?? null;
        },
      };
      return stmt;
    },
    _tables: tables,
  } as unknown as D1Database & { _tables: MakotoTables };

  return db;
}

// ---------------------------------------------------------------------------
// fetch mock — URL-routed responses
// ---------------------------------------------------------------------------

export type FetchMockHandler = (
  url: string,
  init: RequestInit,
) => Promise<Response> | Response;

/**
 * Build a `fetch`-compatible mock. Hands the request to `handler`;
 * the handler returns a `Response` synchronously or asynchronously.
 * Records the call sequence on `fetchMock.calls` for assertions.
 */
export function makeFetchMock(handler: FetchMockHandler): typeof fetch & {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return await handler(url, init);
  }) as typeof fetch & { calls: typeof calls };
  mock.calls = calls;
  return mock;
}

// ---------------------------------------------------------------------------
// AES-GCM-256 vault helper key (raw 32 bytes, base64) for oauth-vault tests
// ---------------------------------------------------------------------------

/**
 * 32-byte zero key, base64-encoded. Convenient for tests — no
 * randomness required, the vault module accepts any 32-byte key.
 */
export const TEST_VAULT_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Random 32-byte key in base64. Use when a test needs distinct keys
 * (cross-user isolation tests, etc).
 */
export function randomVaultKeyB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// ---------------------------------------------------------------------------
// Fake ThreadLock DO namespace
// ---------------------------------------------------------------------------

/**
 * In-memory fake of the `MAKOTO_THREAD_LOCK` DO namespace. Mirrors the
 * Cloudflare DO surface enough for `getThreadLock()` to drive it via
 * `idFromName(...).get(...).fetch(url)`.
 *
 * Each `idFromName(name)` returns a DO id object; `.get(id)` returns a
 * stub with a `fetch(url)` method that runs the same routing the real
 * `ThreadLock.fetch` does.
 */
export function makeFakeThreadLockNamespace(): DurableObjectNamespace {
  const locks = new Map<string, Map<string, number>>();
  const ns = {
    idFromName(name: string) {
      // Wrap so caller can pass it back via `get(id)`.
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      if (!locks.has(name)) locks.set(name, new Map());
      const perInstance = locks.get(name)!;
      return {
        async fetch(url: string): Promise<Response> {
          const u = new URL(url);
          const action = u.searchParams.get('action');
          const key = u.searchParams.get('key') ?? 'default';
          const ttlRaw = u.searchParams.get('ttl_ms');
          const ttl = ttlRaw ? Number.parseInt(ttlRaw, 10) : 5 * 60 * 1000;
          const now = Date.now();
          if (action === 'acquire') {
            const existing = perInstance.get(key);
            if (existing !== undefined && existing > now) {
              return Response.json({
                acquired: false,
                retry_after_ms: existing - now,
              });
            }
            perInstance.set(key, now + ttl);
            return Response.json({ acquired: true });
          }
          if (action === 'release') {
            perInstance.delete(key);
            return Response.json({ released: true });
          }
          if (action === 'extend') {
            perInstance.set(key, now + ttl);
            return Response.json({ extended: true });
          }
          return new Response('unknown action', { status: 400 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return ns;
}

/**
 * Fake `OAuthLease` DO namespace for tests that wire the real
 * `getOAuthLease(env, userSlug)` helper through to a dispatcher path.
 * Mirrors enough of the contract that `getOrLease` → `commit` /
 * `release` / `invalidate` round-trips work. Audit is no-op (the
 * real DO writes to D1 `oauth_audit` via env.DB; this fake skips it
 * because dispatcher tests don't assert on that table here).
 */
export function makeFakeOAuthLeaseNamespace(): DurableObjectNamespace {
  interface PerUserState {
    tokens: { accessToken: string; expiresAt: number } | null;
    leaseId: string | null;
    leaseExpiresAt: number;
  }
  const perUser = new Map<string, PerUserState>();
  function get(name: string): PerUserState {
    let state = perUser.get(name);
    if (!state) {
      state = { tokens: null, leaseId: null, leaseExpiresAt: 0 };
      perUser.set(name, state);
    }
    return state;
  }
  const ns = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      const state = get(name);
      return {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          const u = new URL(url);
          const action = u.searchParams.get('action');
          const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
          const now = Date.now();
          if (action === 'getOrLease') {
            if (state.tokens && state.tokens.expiresAt - 60_000 > now) {
              return Response.json({
                kind: 'cached',
                accessToken: state.tokens.accessToken,
                expiresInMs: state.tokens.expiresAt - now,
              });
            }
            if (state.leaseId && state.leaseExpiresAt > now) {
              return Response.json({ kind: 'busy', retryAfterMs: state.leaseExpiresAt - now });
            }
            const id = `lease-${name}-${Math.random().toString(36).slice(2, 8)}`;
            state.leaseId = id;
            state.leaseExpiresAt = now + 30_000;
            return Response.json({ kind: 'leased', leaseId: id, leaseTtlMs: 30_000 });
          }
          if (action === 'commit') {
            if (state.leaseId !== body.leaseId) {
              return Response.json({ ok: false, reason: 'lease not held' }, { status: 409 });
            }
            state.tokens = {
              accessToken: body.accessToken,
              expiresAt: now + body.expiresInMs,
            };
            state.leaseId = null;
            return Response.json({ ok: true });
          }
          if (action === 'release') {
            if (state.leaseId === body.leaseId) state.leaseId = null;
            return Response.json({ ok: true });
          }
          if (action === 'invalidate') {
            state.tokens = null;
            state.leaseId = null;
            return Response.json({ ok: true });
          }
          return new Response('unknown action', { status: 400 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return ns;
}

// ---------------------------------------------------------------------------
// svix signature helper (for webhook tests)
// ---------------------------------------------------------------------------

/**
 * Compute the svix-format `v1,<base64>` signature for a payload + secret.
 * Mirrors the verifier in `src/webhooks/agentmail.ts:verifySvixSignature`.
 */
export async function svixSign(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: ArrayBuffer | Uint8Array | string,
): Promise<string> {
  const encoder = new TextEncoder();
  // Decode the secret the same way the verifier does:
  // `whsec_<base64>` → base64-decode; otherwise raw UTF-8 bytes.
  let keyBytes: Uint8Array;
  if (secret.startsWith('whsec_')) {
    const b64 = secret.slice('whsec_'.length);
    const bin = atob(b64);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } else {
    try {
      const bin = atob(secret);
      keyBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
    } catch {
      keyBytes = encoder.encode(secret);
    }
  }
  const bodyBytes =
    typeof rawBody === 'string'
      ? encoder.encode(rawBody)
      : rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);
  const prefix = encoder.encode(`${svixId}.${svixTimestamp}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, signed);
  const bytes = new Uint8Array(mac);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `v1,${btoa(bin)}`;
}

// ---------------------------------------------------------------------------
// Fake Cloudflare Queue
// ---------------------------------------------------------------------------

export function makeFakeQueue<T>(): Queue<T> & { _sent: T[] } {
  const sent: T[] = [];
  const q = {
    async send(msg: T): Promise<void> {
      sent.push(msg);
    },
    async sendBatch(msgs: Array<{ body: T }>): Promise<void> {
      for (const m of msgs) sent.push(m.body);
    },
    _sent: sent,
  } as unknown as Queue<T> & { _sent: T[] };
  return q;
}

// ---------------------------------------------------------------------------
// re-exports for convenience
// ---------------------------------------------------------------------------

export { makeKv };
