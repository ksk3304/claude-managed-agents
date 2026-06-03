#!/usr/bin/env node
/**
 * MAKOTOくん 新メンバー onboarding CLI (TS, Cloudflare 単独運用版).
 *
 * Python 版 (`scripts/cma_lib.py`) の 3 関数を TS port し、Cloud Run / Mac mini
 * 依存なしで Cloudflare 単独で新メンバーを追加できるようにする (= Issue #186 K).
 *
 * Sub-commands:
 *   init-user-memory-stores  --user-slug X --agent-number 0001
 *   copy-agent               --from <template_agent_id> --to-slug X --display-name "..." --addendum "..."
 *   register-user-mapping    --slug X --email Y --agent-id A --display-name "..." [--chat-user-id ...] --addendum "..."
 *                            --agent-number 0001
 *                            [--store-id "<actual_name>=<memstore_id>" ...]
 *
 * Common flags:
 *   --dry-run        : API / KV / D1 write をスキップ、stub ID 返却
 *   --help / -h      : usage 表示
 *   --json           : 結果を JSON で標準出力 (= shell パイプライン向け)
 *
 * 環境変数 (real mode で必須):
 *   ANTHROPIC_API_KEY              : Anthropic API key (`sk-ant-...`)
 *   ANTHROPIC_BASE_URL             : optional. default https://api.anthropic.com
 *   CLOUDFLARE_KV_NAMESPACE_ID     : MAKOTO_KV の namespace id (= wrangler.jsonc の
 *                                    `kv_namespaces[*].id`)。dry-run では不要。
 *   CLOUDFLARE_D1_DATABASE_NAME    : D1 database 名 (= wrangler.jsonc の
 *                                    `d1_databases[*].database_name`)。dry-run では不要。
 *
 * KV / D1 アクセスは `wrangler kv key put` / `wrangler d1 execute` を spawn する。
 * worker と同じ binding を介すと Node 経由では呼べないため、CF が公式に提供する
 * subprocess 経路で代用する (real mode のみ。dry-run / test ではメモリ fake).
 *
 * 起動例:
 *   npx tsx src/cli/onboarding.ts --help
 *   npx tsx src/cli/onboarding.ts init-user-memory-stores --user-slug yamada --agent-number 0001 --dry-run
 *
 * Issue: ksk3304/makoto-prime#186 (K)
 */

import { spawn } from 'node:child_process';
import {
  copyAgent,
  initUserMemoryStores,
  registerUserMapping,
  type AnthropicClientLike,
  type D1AuditWriter,
  type KvLike,
  type RegisterMappingResult,
  type InitMemoryStoresResult,
  type CopyAgentResult,
} from './onboarding-core';
import { DEFAULT_MEMORY_STORE_COMPANY_NAME } from './store-config';

// ---------------------------------------------------------------------------
// argv parser (= minimal long-flag parser, dependency なし)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | null;
  flags: Map<string, string | true>;
  multi: Map<string, string[]>; // for repeated flags like --store-id
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    flags: new Map(),
    multi: new Map(),
    rest: [],
  };
  if (argv.length === 0) return out;

  let i = 0;
  // First non-flag token = command
  while (i < argv.length) {
    const a = argv[i]!;
    if (a.startsWith('-')) break;
    out.command = a;
    i++;
    break;
  }

  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      out.flags.set('help', true);
      i++;
      continue;
    }
    if (a === '--dry-run') {
      out.flags.set('dry-run', true);
      i++;
      continue;
    }
    if (a === '--json') {
      out.flags.set('json', true);
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags.set(key, true);
        i++;
        continue;
      }
      // store-id can repeat
      if (key === 'store-id') {
        const arr = out.multi.get(key) ?? [];
        arr.push(next);
        out.multi.set(key, arr);
      } else {
        out.flags.set(key, next);
      }
      i += 2;
      continue;
    }
    out.rest.push(a);
    i++;
  }
  return out;
}

function getString(p: ParsedArgs, key: string): string | undefined {
  const v = p.flags.get(key);
  if (v === undefined || v === true) return undefined;
  return v;
}

function requireString(p: ParsedArgs, key: string, cmd: string): string {
  const v = getString(p, key);
  if (!v) {
    throw new Error(`${cmd}: --${key} is required`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Wrangler subprocess adapters (real mode)
// ---------------------------------------------------------------------------

async function runWrangler(args: string[], stdin?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('npx', ['wrangler', ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler ${args.join(' ')} exited with code ${code}`));
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function makeWranglerKv(namespaceId: string, remote: boolean): KvLike {
  const env = remote ? '--remote' : '--local';
  return {
    async get(key: string): Promise<string | null> {
      try {
        const out = await runWrangler([
          'kv',
          'key',
          'get',
          key,
          '--namespace-id',
          namespaceId,
          env,
        ]);
        // wrangler kv key get prints value verbatim; empty stdout = absent
        const trimmed = out.replace(/\n$/, '');
        return trimmed.length === 0 ? null : trimmed;
      } catch (err) {
        // wrangler exits non-zero when key missing — treat as null
        if (String(err).includes('exited with code')) return null;
        throw err;
      }
    },
    async put(key: string, value: string): Promise<void> {
      await runWrangler([
        'kv',
        'key',
        'put',
        key,
        value,
        '--namespace-id',
        namespaceId,
        env,
      ]);
    },
  };
}

function makeWranglerD1Audit(dbName: string, remote: boolean): D1AuditWriter {
  const env = remote ? '--remote' : '--local';
  return {
    async insertUserMappingAudit(row) {
      // SQL injection 回避のため値は parameterized 形にしたいが、wrangler d1 execute
      // は --command でクエリ文字列のみ受ける (パラメタ非対応)。CLI 入力は内部用途
      // (managed onboarding) なので、SQL escape 関数で個別 escape する。
      const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const notesPart = row.notes !== undefined ? esc(row.notes) : 'NULL';
      const sql =
        `INSERT INTO user_mapping_audit ` +
        `(email, user_slug, agent_id, event_type, registered_at_ms, notes) VALUES (` +
        `${esc(row.email)}, ${esc(row.user_slug)}, ${esc(row.agent_id)}, ` +
        `${esc(row.event_type)}, ${row.registered_at_ms}, ${notesPart});`;
      await runWrangler(['d1', 'execute', dbName, env, '--command', sql]);
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic client factory (real mode)
// ---------------------------------------------------------------------------

async function makeAnthropic(): Promise<AnthropicClientLike> {
  // dynamic import to avoid loading the SDK in tests / dry-run-only paths
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY env not set (real mode requires it)');
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({ apiKey, baseURL });
  // The shape returned by @anthropic-ai/sdk matches AnthropicClientLike
  // structurally (beta.memoryStores / beta.agents). Cast through unknown.
  return client as unknown as AnthropicClientLike;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `MAKOTOくん 新メンバー onboarding CLI (Cloudflare 単独運用版)

使い方:
  npx tsx src/cli/onboarding.ts <subcommand> [flags]

Sub-commands:
  init-user-memory-stores   新規 agent 用 numbered memory store を発行
  copy-agent                雛形 agent を copy して新 user 用 agent を発行
  register-user-mapping     KV (user_mapping:<email>) に登録 + D1 audit 記録

Common flags:
  --dry-run                 API / KV / D1 write をスキップ、stub ID で返却
  --json                    結果を JSON で stdout に出力
  --help, -h                このメッセージを表示

Sub-command flags:
  init-user-memory-stores --user-slug <slug> --agent-number <0001>
                          [--company-name "Makoto Prime"]

  copy-agent --from <template_agent_id> --to-slug <slug>
             --display-name "<name>" --addendum "<text>"

  register-user-mapping --slug <slug> --email <addr> --agent-id <id>
                        --display-name "<name>" --addendum "<text>"
                        --agent-number <0001>
                        [--company-name "Makoto Prime"]
                        [--chat-user-id "users/...]
                        [--store-id <actual_name>=<memstore_id> ...]

環境変数 (real mode で必須、--dry-run なら不要):
  ANTHROPIC_API_KEY              Anthropic API key
  CLOUDFLARE_KV_NAMESPACE_ID     MAKOTO_KV namespace id (wrangler.jsonc 参照)
  CLOUDFLARE_D1_DATABASE_NAME    D1 database 名 (wrangler.jsonc 参照)

KV/D1 への real write は wrangler subprocess (\`npx wrangler kv key put\` /
\`npx wrangler d1 execute\`) で実行する (= worker と同じ binding を Node から
直接は呼べないため、CF 公式の管理経路を介する)。
本番反映先を切替える時は --remote (default) / 環境変数 CMA_ONBOARDING_TARGET=local
で切替可能。

例:
  npx tsx src/cli/onboarding.ts init-user-memory-stores --user-slug yamada --agent-number 0001 --company-name "Makoto Prime" --dry-run
  npx tsx src/cli/onboarding.ts copy-agent --from agent_xxx --to-slug yamada \\
      --display-name "山田 太郎" --addendum "あなたは山田 太郎さん専属の MAKOTOくんです" --dry-run
  npx tsx src/cli/onboarding.ts register-user-mapping --slug yamada \\
      --email yamada@example.com --agent-id agent_yyy \\
      --display-name "山田 太郎" --addendum "..." --agent-number 0001 \\
      --store-id "Makoto Prime_0001_session_log_store=memstore_xxx" \\
      --store-id "company_core_memory=memstore_common_xxx" --dry-run
`;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseStoreIdFlags(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--store-id expects "<actual_name>=<memstore_id>", got ${JSON.stringify(v)}`);
    }
    const k = v.slice(0, eq).trim();
    const id = v.slice(eq + 1).trim();
    if (!k || !id) {
      throw new Error(`--store-id has empty key or value: ${JSON.stringify(v)}`);
    }
    out[k] = id;
  }
  return out;
}

function resolveCompanyName(p: ParsedArgs): string {
  return (
    getString(p, 'company-name') ??
    process.env.MAKOTO_MEMORY_COMPANY_NAME ??
    DEFAULT_MEMORY_STORE_COMPANY_NAME
  );
}

async function cmdInitStores(p: ParsedArgs): Promise<InitMemoryStoresResult> {
  const userSlug = requireString(p, 'user-slug', 'init-user-memory-stores');
  const agentNumber = requireString(p, 'agent-number', 'init-user-memory-stores');
  const companyName = resolveCompanyName(p);
  const dryRun = p.flags.has('dry-run');

  if (dryRun) {
    // dry-run: Anthropic / KV を呼ばない
    const fakeAnthropic = createNoopAnthropic();
    const fakeKv = createInMemoryKv();
    return await initUserMemoryStores({
      anthropic: fakeAnthropic,
      kv: fakeKv,
      userSlug,
      agentNumber,
      companyName,
      dryRun: true,
    });
  }

  const { kvNamespaceId, remote } = resolveCfTargets();
  const anthropic = await makeAnthropic();
  const kv = makeWranglerKv(kvNamespaceId, remote);
  return await initUserMemoryStores({
    anthropic,
    kv,
    userSlug,
    agentNumber,
    companyName,
    dryRun: false,
  });
}

async function cmdCopyAgent(p: ParsedArgs): Promise<CopyAgentResult> {
  const templateAgentId = requireString(p, 'from', 'copy-agent');
  const userSlug = requireString(p, 'to-slug', 'copy-agent');
  const displayName = requireString(p, 'display-name', 'copy-agent');
  const addendum = requireString(p, 'addendum', 'copy-agent');
  const dryRun = p.flags.has('dry-run');

  if (dryRun) {
    return await copyAgent({
      anthropic: createNoopAnthropic(),
      templateAgentId,
      userSlug,
      displayName,
      addendum,
      dryRun: true,
    });
  }
  const anthropic = await makeAnthropic();
  return await copyAgent({
    anthropic,
    templateAgentId,
    userSlug,
    displayName,
    addendum,
    dryRun: false,
  });
}

async function cmdRegisterMapping(p: ParsedArgs): Promise<RegisterMappingResult> {
  const userSlug = requireString(p, 'slug', 'register-user-mapping');
  const userEmail = requireString(p, 'email', 'register-user-mapping');
  const agentId = requireString(p, 'agent-id', 'register-user-mapping');
  const agentNumber = requireString(p, 'agent-number', 'register-user-mapping');
  const companyName = resolveCompanyName(p);
  const displayName = requireString(p, 'display-name', 'register-user-mapping');
  const addendum = requireString(p, 'addendum', 'register-user-mapping');
  const chatUserId = getString(p, 'chat-user-id');
  const dryRun = p.flags.has('dry-run');
  const storeIds = parseStoreIdFlags(p.multi.get('store-id') ?? []);

  if (dryRun) {
    return await registerUserMapping({
      kv: createInMemoryKv(),
      audit: createNoopAudit(),
      storeIds,
      userEmail,
      userSlug,
      agentNumber,
      companyName,
      agentId,
      displayName,
      chatUserId,
      addendum,
      dryRun: true,
    });
  }

  const { kvNamespaceId, d1DbName, remote } = resolveCfTargets({ requireD1: true });
  const kv = makeWranglerKv(kvNamespaceId, remote);
  const audit = makeWranglerD1Audit(d1DbName, remote);
  return await registerUserMapping({
    kv,
    audit,
    storeIds,
    userEmail,
    userSlug,
    agentNumber,
    companyName,
    agentId,
    displayName,
    chatUserId,
    addendum,
    dryRun: false,
  });
}

// ---------------------------------------------------------------------------
// Helpers (in-memory fakes for dry-run)
// ---------------------------------------------------------------------------

function createInMemoryKv(): KvLike {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function createNoopAudit(): D1AuditWriter {
  return {
    async insertUserMappingAudit() {
      // no-op in dry-run
    },
  };
}

function createNoopAnthropic(): AnthropicClientLike {
  return {
    beta: {
      memoryStores: {
        async create() {
          throw new Error('createNoopAnthropic: create called in dry-run');
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        list(): AsyncIterable<{ id: string; name: string }> {
          return {
            [Symbol.asyncIterator]: async function* () {
              // empty
            },
          };
        },
      },
      agents: {
        async retrieve() {
          throw new Error('createNoopAnthropic: retrieve called in dry-run');
        },
        async create() {
          throw new Error('createNoopAnthropic: agents.create called in dry-run');
        },
      },
    },
  };
}

function resolveCfTargets(opts: { requireD1?: boolean } = {}): {
  kvNamespaceId: string;
  d1DbName: string;
  remote: boolean;
} {
  const kvNamespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  if (!kvNamespaceId) {
    throw new Error(
      'CLOUDFLARE_KV_NAMESPACE_ID env not set (= MAKOTO_KV id from wrangler.jsonc)',
    );
  }
  const d1DbName = process.env.CLOUDFLARE_D1_DATABASE_NAME ?? '';
  if (opts.requireD1 && !d1DbName) {
    throw new Error(
      'CLOUDFLARE_D1_DATABASE_NAME env not set (= D1 database_name from wrangler.jsonc)',
    );
  }
  const target = (process.env.CMA_ONBOARDING_TARGET ?? 'remote').toLowerCase();
  const remote = target !== 'local';
  return { kvNamespaceId, d1DbName, remote };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv);

  if (p.flags.has('help') || p.command === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    let result: unknown;
    switch (p.command) {
      case 'init-user-memory-stores':
        result = await cmdInitStores(p);
        break;
      case 'copy-agent':
        result = await cmdCopyAgent(p);
        break;
      case 'register-user-mapping':
        result = await cmdRegisterMapping(p);
        break;
      default:
        process.stderr.write(`unknown sub-command: ${p.command}\n\n`);
        process.stdout.write(USAGE);
        return 2;
    }
    if (p.flags.has('json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatHuman(p.command, result)}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function formatHuman(command: string, result: unknown): string {
  if (command === 'init-user-memory-stores') {
    const r = result as InitMemoryStoresResult;
    const lines = [`[init-user-memory-stores] stores:`];
    for (const [name, id] of Object.entries(r.stores)) {
      const tag = r.created.includes(name) ? 'CREATED' : 'CACHED';
      lines.push(`  ${name} = ${id} (${tag})`);
    }
    return lines.join('\n');
  }
  if (command === 'copy-agent') {
    const r = result as CopyAgentResult;
    return (
      `[copy-agent] new agent_id = ${r.newAgentId} ` +
      `(template=${r.templateAgentId}, display_name='${r.displayName}')`
    );
  }
  if (command === 'register-user-mapping') {
    const r = result as RegisterMappingResult;
    return (
      `[register-user-mapping] ${r.eventType} ${r.email} -> ` +
      `agent_id=${r.value.agent_id} slug=${r.value.user_slug} ` +
      `(KV key: ${r.kvKey}, ${r.value.memory_attachments.length} attachments)`
    );
  }
  return JSON.stringify(result, null, 2);
}

// CLI auto-run when executed directly via tsx / node
// (in tests we import main and skip this branch)
const invokedDirectly = (() => {
  try {
    // import.meta.url is the loaded TS file URL when run via tsx
    const here = import.meta.url;
    const entry = process.argv[1];
    if (!entry) return false;
    // path-suffix match keeps us compatible with both .ts and compiled .js
    return here.endsWith(entry.replace(/\\/g, '/').split('/').slice(-1)[0]!);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
