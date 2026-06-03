/**
 * Unit tests for `src/cli/onboarding-core.ts` の 3 関数 + `src/cli/onboarding.ts`
 * の CLI 起動 (--help).
 *
 * Issue: ksk3304/makoto-prime#186 (K = Onboarding CLI)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  copyAgent,
  initUserMemoryStores,
  registerUserMapping,
  normalizeMappingEmail,
  type AnthropicClientLike,
  type D1AuditWriter,
  type KvLike,
} from '../src/cli/onboarding-core';
import {
  AGENT_SCOPED_STORES,
  AGENT_SCOPED_STORE_SET,
  COMMON_STORES,
  actualStoreName,
} from '../src/cli/store-config';
import { MAKOTO_TOOL_NAMES } from '../src/lib/makoto-capability-registry';
import { main } from '../src/cli/onboarding';

// ---- in-memory fakes ----

function makeKvFake(): KvLike & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function makeAuditFake(): D1AuditWriter & { _rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    _rows: rows,
    async insertUserMappingAudit(row) {
      rows.push({ ...row });
    },
  };
}

function makeAnthropicFake(opts: {
  existing?: Array<{ id: string; name: string }>;
  template?: {
    id: string;
    name: string;
    model: unknown;
    system: string | null;
    tools: unknown;
    skills: unknown;
  };
} = {}): AnthropicClientLike & {
  _created: Array<{ name: string; description?: string }>;
  _agentsCreated: Array<{ name: string; system: string; tools?: unknown }>;
} {
  const existing = [...(opts.existing ?? [])];
  const created: Array<{ name: string; description?: string }> = [];
  const agentsCreated: Array<{ name: string; system: string; tools?: unknown }> = [];
  return {
    _created: created,
    _agentsCreated: agentsCreated,
    beta: {
      memoryStores: {
        async create(params) {
          created.push({ name: params.name, description: params.description });
          const newId = `memstore_${params.name}_${created.length}`;
          existing.push({ id: newId, name: params.name });
          return { id: newId, name: params.name };
        },
        list() {
          const snapshot = [...existing];
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const s of snapshot) yield s;
            },
          };
        },
      },
      agents: {
        async retrieve(agentId) {
          if (!opts.template || opts.template.id !== agentId) {
            throw new Error(`fake: unknown template agent ${agentId}`);
          }
          return opts.template;
        },
        async create(params) {
          agentsCreated.push({ name: params.name, system: params.system, tools: params.tools });
          return { id: `agent_${agentsCreated.length}_new`, name: params.name };
        },
      },
    },
  };
}

// ---- initUserMemoryStores ----

describe('initUserMemoryStores', () => {
  it('dry-run returns stub IDs without calling the API', async () => {
    const kv = makeKvFake();
    const ant = makeAnthropicFake();
    const r = await initUserMemoryStores({
      anthropic: ant,
      kv,
      userSlug: 'yamada',
      agentNumber: '0001',
      dryRun: true,
    });
    expect(Object.keys(r.stores).sort()).toEqual(
      AGENT_SCOPED_STORES.map((n) => actualStoreName(n, '0001')).sort(),
    );
    for (const id of Object.values(r.stores)) {
      expect(id.startsWith('DRY_RUN_')).toBe(true);
    }
    expect(ant._created).toEqual([]);
    expect(kv._store.size).toBe(0);
  });

  it('real mode creates new stores and caches them in KV', async () => {
    const kv = makeKvFake();
    const ant = makeAnthropicFake();
    const r = await initUserMemoryStores({
      anthropic: ant,
      kv,
      userSlug: 'yamada',
      agentNumber: '0001',
      dryRun: false,
    });
    expect(ant._created.length).toBe(AGENT_SCOPED_STORES.length);
    // KV cached
    for (const [actualName, id] of Object.entries(r.stores)) {
      expect(kv._store.get(`memstore_id:${actualName}`)).toBe(id);
    }
    // Names are agent_<number>_<purpose>.
    for (const logical of AGENT_SCOPED_STORES) {
      const actual = actualStoreName(logical, '0001');
      expect(r.stores[actual]).toBeDefined();
    }
  });

  it('cache hit skips the create call (idempotent re-run)', async () => {
    const kv = makeKvFake();
    const ant = makeAnthropicFake();
    // 1st run: create
    await initUserMemoryStores({
      anthropic: ant,
      kv,
      userSlug: 'yamada',
      agentNumber: '0001',
      dryRun: false,
    });
    const createdFirst = ant._created.length;
    expect(createdFirst).toBeGreaterThan(0);
    // 2nd run: should hit KV cache
    const r2 = await initUserMemoryStores({
      anthropic: ant,
      kv,
      userSlug: 'yamada',
      agentNumber: '0001',
      dryRun: false,
    });
    expect(ant._created.length).toBe(createdFirst); // no new creates
    expect(r2.created).toEqual([]);
    expect(r2.cached.length).toBe(AGENT_SCOPED_STORES.length);
  });

  it('falls back to list() when KV cache is empty but the store already exists upstream', async () => {
    const kv = makeKvFake();
    const actualName = actualStoreName('agent_session_log_store', '0001');
    const ant = makeAnthropicFake({
      existing: [{ id: 'memstore_pre_existing_1', name: actualName }],
    });
    const r = await initUserMemoryStores({
      anthropic: ant,
      kv,
      userSlug: 'yamada',
      agentNumber: '0001',
      dryRun: false,
    });
    expect(r.stores[actualName]).toBe('memstore_pre_existing_1');
    expect(ant._created.length).toBe(AGENT_SCOPED_STORES.length - 1);
    // KV is now populated for both
    expect(kv._store.get(`memstore_id:${actualName}`)).toBe('memstore_pre_existing_1');
  });
});

// ---- copyAgent ----

describe('copyAgent', () => {
  it('dry-run returns a stub agent ID without calling the API', async () => {
    const ant = makeAnthropicFake();
    const r = await copyAgent({
      anthropic: ant,
      templateAgentId: 'agent_xxx',
      userSlug: 'yamada',
      displayName: '山田 太郎',
      addendum: 'あなたは山田 太郎さん専属の MAKOTOくんです。',
      dryRun: true,
    });
    expect(r.newAgentId).toBe('DRY_RUN_agent_yamada');
    expect(ant._agentsCreated).toEqual([]);
  });

  it('retrieves the template, concatenates the addendum to system, and creates a new agent', async () => {
    const ant = makeAnthropicFake({
      template: {
        id: 'agent_template_1',
        name: 'MAKOTOくん (template)',
        model: { type: 'model', id: 'claude-sonnet-4-6' },
        system: 'You are MAKOTOくん.',
        tools: [{ type: 'bash' }],
        skills: ['skill_a'],
      },
    });
    const r = await copyAgent({
      anthropic: ant,
      templateAgentId: 'agent_template_1',
      userSlug: 'yamada',
      displayName: '山田 太郎',
      addendum: 'あなたは山田さん専属です',
      dryRun: false,
    });
    expect(r.newAgentId).toBe('agent_1_new');
    expect(ant._agentsCreated.length).toBe(1);
    const created = ant._agentsCreated[0]!;
    expect(created.name).toBe('MAKOTOくん (山田 太郎用)');
    expect(created.system).toBe('You are MAKOTOくん.\n\nあなたは山田さん専属です');
    const tools = (created.tools ?? []) as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ type: 'bash' });
    const customToolNames = tools
      .filter((tool) => tool.type === 'custom')
      .map((tool) => tool.name);
    expect(customToolNames.sort()).toEqual([...MAKOTO_TOOL_NAMES].sort());
    expect(customToolNames).toContain('makoto_introspect');
  });

  it('throws when SDK returns null system / undefined model (fail-fast)', async () => {
    const ant = makeAnthropicFake({
      template: {
        id: 'agent_broken',
        name: 'broken',
        model: undefined,
        system: 'present',
        tools: null,
        skills: null,
      },
    });
    await expect(
      copyAgent({
        anthropic: ant,
        templateAgentId: 'agent_broken',
        userSlug: 'yamada',
        displayName: '山田',
        addendum: '...',
        dryRun: false,
      }),
    ).rejects.toThrow(/did not return system\/model/);
  });
});

// ---- registerUserMapping ----

describe('registerUserMapping', () => {
  function makeStoreIdsForAgent(agentNumber: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const logical of COMMON_STORES) {
      const actual = actualStoreName(logical, agentNumber);
      out[actual] = `memstore_id_for_${actual}`;
    }
    return out;
  }

  it('dry-run produces the value without touching KV / D1', async () => {
    const kv = makeKvFake();
    const audit = makeAuditFake();
    const r = await registerUserMapping({
      kv,
      audit,
      storeIds: {}, // dry-run なので missing チェックは走らない (skip)
      userEmail: 'YAMADA@Example.COM',
      userSlug: 'yamada',
      agentNumber: '0001',
      agentId: 'agent_y',
      displayName: '山田 太郎',
      addendum: 'addendum',
      dryRun: true,
      nowMs: 1_700_000_000_000,
    });
    expect(r.email).toBe('yamada@example.com');
    expect(r.kvKey).toBe('user_mapping:yamada@example.com');
    expect(kv._store.size).toBe(0);
    expect(audit._rows.length).toBe(0);
  });

  it('real mode writes to KV and appends an audit row', async () => {
    const kv = makeKvFake();
    const audit = makeAuditFake();
    const r = await registerUserMapping({
      kv,
      audit,
      storeIds: makeStoreIdsForAgent('0001'),
      userEmail: 'yamada@example.com',
      userSlug: 'yamada',
      agentNumber: '0001',
      agentId: 'agent_y',
      displayName: '山田 太郎',
      chatUserId: 'users/12345',
      addendum: 'addendum',
      dryRun: false,
      nowMs: 1_700_000_000_000,
    });
    expect(r.eventType).toBe('register');
    expect(kv._store.get('user_mapping:yamada@example.com')).toBeDefined();
    const stored = JSON.parse(kv._store.get('user_mapping:yamada@example.com')!);
    expect(stored.user_slug).toBe('yamada');
    expect(stored.agent_number).toBe('0001');
    expect(stored.agent_id).toBe('agent_y');
    expect(stored.memory_attachments.length).toBe(COMMON_STORES.length);
    const logAttachment = stored.memory_attachments.find(
      (a: { store_name: string }) => a.store_name === 'agent_0001_session_log_store',
    );
    expect(logAttachment).toBeDefined();
    expect(logAttachment.memory_store_id).toBe(
      'memstore_id_for_agent_0001_session_log_store',
    );
    // audit row
    expect(audit._rows.length).toBe(1);
    expect(audit._rows[0]).toMatchObject({
      email: 'yamada@example.com',
      user_slug: 'yamada',
      agent_id: 'agent_y',
      event_type: 'register',
      registered_at_ms: 1_700_000_000_000,
    });
  });

  it('re-register (same email, new agent_id) marks event_type as re-register', async () => {
    const kv = makeKvFake();
    const audit = makeAuditFake();
    const storeIds = makeStoreIdsForAgent('0001');
    // 1st: register
    await registerUserMapping({
      kv,
      audit,
      storeIds,
      userEmail: 'yamada@example.com',
      userSlug: 'yamada',
      agentNumber: '0001',
      agentId: 'agent_first',
      displayName: '山田',
      addendum: 'x',
      dryRun: false,
    });
    // 2nd: same email, different agent_id
    const r2 = await registerUserMapping({
      kv,
      audit,
      storeIds,
      userEmail: 'yamada@example.com',
      userSlug: 'yamada',
      agentNumber: '0001',
      agentId: 'agent_second',
      displayName: '山田',
      addendum: 'x',
      dryRun: false,
    });
    expect(r2.eventType).toBe('re-register');
    expect(audit._rows.length).toBe(2);
    expect(audit._rows[1]!.event_type).toBe('re-register');
    const stored = JSON.parse(kv._store.get('user_mapping:yamada@example.com')!);
    expect(stored.agent_id).toBe('agent_second');
  });

  it('fails fast in real mode when a required store id is missing', async () => {
    const kv = makeKvFake();
    const audit = makeAuditFake();
    await expect(
      registerUserMapping({
        kv,
        audit,
        storeIds: {}, // missing all
        userEmail: 'yamada@example.com',
        userSlug: 'yamada',
        agentNumber: '0001',
        agentId: 'agent_y',
        displayName: '山田',
        addendum: 'x',
        dryRun: false,
      }),
    ).rejects.toThrow(/store id missing/);
  });

  it('normalizeMappingEmail lowercases and trims', () => {
    expect(normalizeMappingEmail('  YAMADA@Example.COM ')).toBe('yamada@example.com');
  });
});

// ---- store-config sanity ----

describe('store-config', () => {
  it('AGENT_SCOPED_STORE_SET = AGENT_SCOPED_STORES', () => {
    expect([...AGENT_SCOPED_STORE_SET].sort()).toEqual([...AGENT_SCOPED_STORES].sort());
  });

  it('actualStoreName prefixes agent number only for agent-scoped stores', () => {
    expect(actualStoreName('agent_session_log_store', '1')).toBe(
      'agent_0001_session_log_store',
    );
    expect(actualStoreName('company_core_memory', '1')).toBe('company_core_memory');
  });
});

// ---- CLI main (--help / unknown command / dry-run E2E) ----

describe('CLI main', () => {
  it('prints usage on --help and exits 0', async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(['--help']);
      expect(code).toBe(0);
      const all = writes.join('');
      expect(all).toMatch(/onboarding CLI/);
      expect(all).toMatch(/init-user-memory-stores/);
      expect(all).toMatch(/copy-agent/);
      expect(all).toMatch(/register-user-mapping/);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('unknown sub-command returns exit code 2', async () => {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await main(['nope']);
      expect(code).toBe(2);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it('init-user-memory-stores --dry-run runs end-to-end and returns 0', async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main([
        'init-user-memory-stores',
        '--user-slug',
        'yamada',
        '--agent-number',
        '0001',
        '--dry-run',
      ]);
      expect(code).toBe(0);
      const all = writes.join('');
      expect(all).toMatch(/DRY_RUN_agent_0001_session_log_store/);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
