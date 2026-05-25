// Lightweight in-memory fakes for the storage module the AgentMail
// bridge cron runs against. v4 trims this to the tables `storage.ts`
// actually touches: sent_messages.
//
// Tests for the bridge runtime (queues / webhooks / tools / OAuth /
// dedupe / svix dedupe) live under `tests/makoto-helpers.ts` and use
// dedicated fakes there.

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

// ---- KV ----

export function makeKv(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>();

  const kv = {
    async get(key: string, type?: "text" | "json") {
      const entry = store.get(key);
      if (!entry) return null;
      if (type === "json") {
        try { return JSON.parse(entry.value); } catch { return null; }
      }
      return entry.value;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      store.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      const slice = keys.slice(start, start + limit);
      const list_complete = start + limit >= keys.length;
      return {
        keys: slice.map((name) => ({ name, metadata: store.get(name)!.metadata })),
        list_complete,
        cursor: list_complete ? "" : slice[slice.length - 1],
      };
    },
    _store: store,
  } as unknown as KVNamespace;

  return kv;
}

// ---- D1 (sent_messages only) ----

interface FakeRow {
  [k: string]: unknown;
}

interface FakeTables {
  sent_messages: Map<string, FakeRow>;
}

export function makeDb(): D1Database & { _tables: FakeTables } {
  const tables: FakeTables = {
    sent_messages: new Map(),
  };

  function exec(sql: string, params: unknown[]): { results: FakeRow[]; meta?: { changes: number } } {
    const trimmed = sql.replace(/\s+/g, " ").trim();

    // recordSentMessage — INSERT OR REPLACE
    if (/^INSERT OR REPLACE INTO sent_messages/i.test(trimmed)) {
      const [message_id, session_id, agent_id, to_addr, sent_at_ms, rfc822_msgid] = params as [
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
        rfc822_msgid: rfc822_msgid ?? null,
      });
      return { results: [], meta: { changes: 1 } };
    }

    // findSessionByRfc822MessageId
    if (/^SELECT session_id, agent_id FROM sent_messages WHERE rfc822_msgid = \?/i.test(trimmed)) {
      const [rfc822] = params as [string];
      for (const row of tables.sent_messages.values()) {
        if (row.rfc822_msgid === rfc822) {
          return { results: [{ session_id: row.session_id, agent_id: row.agent_id }] };
        }
      }
      return { results: [] };
    }

    // pruneOlderThan (sent_messages only in v4)
    if (/^DELETE FROM sent_messages WHERE sent_at_ms < \?/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [id, row] of tables.sent_messages) {
        if (Number(row.sent_at_ms) < Number(cutoff)) {
          tables.sent_messages.delete(id);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    throw new Error(`fake-db: unrecognised SQL: ${trimmed}`);
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
  } as unknown as D1Database & { _tables: FakeTables };

  return db;
}

// ---- Env factory ----

export interface FakeEnv {
  DB: ReturnType<typeof makeDb>;
}

export function makeEnv(overrides: Partial<FakeEnv> = {}): FakeEnv {
  return {
    DB: makeDb(),
    ...overrides,
  };
}
