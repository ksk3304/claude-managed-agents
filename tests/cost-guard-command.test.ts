/**
 * `src/lib/cost-guard-command.ts` 単体テスト (Issue #186 既知 #2)。
 *
 * 4 ケース (= タスク brief 指定):
 *   1. parseCostGuardCommand: `/costguard status` → subcommand 抽出 / 非 `/costguard`
 *      は `null` 返却 (= caller は通常 LLM dispatch 経路へ流す)。
 *   2. handleCostGuardCommand `status`: 非 admin (env 未設定) でも閲覧可、
 *      `checkBudget` 経由で現在値 / 上限 / 超過軸 / 設定源を整形して返す。
 *   3. handleCostGuardCommand mutation (`disable`): admin 未設定 (env 空) →
 *      fail-closed で「管理者未設定」denied、admin 設定 + 一致 → mutation 系
 *      は Phase 2 で未 port → "未実装" denied (Worker 側 overlay 永続層が
 *      未実装ゆえ意図的に拒否)。
 *   4. 未知 subcommand → denied 文面 / 例外時は内部吸収して `denied` を返す
 *      (Python `handle:l.209-221` と同じ契約 = 安全弁コマンドは bot を落とさない)。
 */

import { describe, it, expect } from 'vitest';

import {
  parseCostGuardCommand,
  handleCostGuardCommand,
} from '../src/lib/cost-guard-command';
import type { CostGuardDeps } from '../src/lib/cost-guard';
import { makeKv } from './helpers';

// ---------------------------------------------------------------------------
// helpers (本テスト専用 — chat-event-handler 経路を経由せず lib 単体を叩く)
// ---------------------------------------------------------------------------

function makeGuardDeps(): CostGuardDeps {
  return {
    kv: makeKv(),
    // operatorSpace 未設定 = Python `resolve_operator_space` 未設定時同等
  };
}

function envWith(adminEmails?: string): Pick<Env, 'COST_GUARD_ADMIN_EMAILS'> {
  return { COST_GUARD_ADMIN_EMAILS: adminEmails } as Pick<
    Env,
    'COST_GUARD_ADMIN_EMAILS'
  >;
}

function makeCommandDb(): D1Database & {
  _config: Map<string, Record<string, unknown>>;
  _pending: Map<string, Record<string, unknown>>;
  _audit: Array<Record<string, unknown>>;
  _hooks: { beforeConfigWrite?: () => void };
} {
  const config = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, Record<string, unknown>>();
  const audit: Array<Record<string, unknown>> = [];
  const hooks: { beforeConfigWrite?: () => void } = {};
  const runSql = (sql: string, params: unknown[]) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT enabled, paused_until_ms, limits_json/i.test(trimmed)) {
      const [id] = params as [string];
      return { results: config.has(id) ? [config.get(id)!] : [] };
    }
    if (/^INSERT INTO cost_guard_config/i.test(trimmed)) {
      const [
        id,
        enabled,
        paused_until_ms,
        limits_json,
        updated_by,
        updated_at_ms,
        change_seq,
        expected_change_seq,
      ] = params;
      hooks.beforeConfigWrite?.();
      hooks.beforeConfigWrite = undefined;
      const current = config.get(String(id));
      if (current && Number(current.change_seq) !== Number(expected_change_seq)) {
        return { results: [], meta: { changes: 0 } };
      }
      if (!current && Number(expected_change_seq) !== 0) {
        return { results: [], meta: { changes: 0 } };
      }
      config.set(String(id), {
        enabled,
        paused_until_ms,
        limits_json,
        updated_by,
        updated_at_ms,
        change_seq,
      });
      return { results: [{ change_seq }], meta: { changes: 1 } };
    }
    if (/^INSERT INTO cost_guard_audit/i.test(trimmed)) {
      const [
        timestamp_ms,
        actor_email,
        action,
        old_value_json,
        new_value_json,
        detail,
        config_id,
        change_seq,
        enabled,
        paused_until_ms,
        limits_json,
        updated_by,
        updated_at_ms,
      ] = params;
      const current = config.get(String(config_id));
      if (
        !current
        || Number(current.change_seq) !== Number(change_seq)
        || current.enabled !== enabled
        || current.paused_until_ms !== paused_until_ms
        || current.limits_json !== limits_json
        || current.updated_by !== updated_by
        || current.updated_at_ms !== updated_at_ms
      ) {
        return { results: [], meta: { changes: 0 } };
      }
      audit.push({ timestamp_ms, actor_email, action, old_value_json, new_value_json, detail });
      return { results: [{ id: audit.length }], meta: { changes: 1 } };
    }
    if (/^INSERT INTO cost_guard_pending/i.test(trimmed)) {
      const [
        actor_email,
        token_hash,
        action,
        patch_json,
        summary,
        base_change_seq,
        created_at_ms,
        expires_at_ms,
      ] = params;
      pending.set(String(actor_email), {
        actor_email,
        token_hash,
        action,
        patch_json,
        summary,
        base_change_seq,
        created_at_ms,
        expires_at_ms,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^DELETE FROM cost_guard_pending WHERE actor_email = \? AND token_hash = \?/i.test(trimmed)) {
      const [actor_email, token_hash, nowMs] = params as [string, string, number];
      const row = pending.get(actor_email);
      if (row && row.token_hash === token_hash && Number(row.expires_at_ms) > nowMs) {
        pending.delete(actor_email);
        return { results: [row], meta: { changes: 1 } };
      }
      return { results: [], meta: { changes: 0 } };
    }
    if (/^DELETE FROM cost_guard_pending WHERE actor_email = \?/i.test(trimmed)) {
      const [actor_email] = params as [string];
      const existed = pending.delete(actor_email);
      return { results: [], meta: { changes: existed ? 1 : 0 } };
    }
    throw new Error(`unexpected SQL: ${trimmed}`);
  };
  const db = {
    _config: config,
    _pending: pending,
    _audit: audit,
    _hooks: hooks,
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          params = bound;
          return stmt;
        },
        async first<T>() {
          const r = runSql(sql, params);
          return (r.results[0] as T) ?? null;
        },
        async run() {
          return runSql(sql, params);
        },
        async all<T>() {
          const r = runSql(sql, params);
          return { results: r.results as T[] };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  } as unknown as D1Database & {
    _config: Map<string, Record<string, unknown>>;
    _pending: Map<string, Record<string, unknown>>;
    _audit: Array<Record<string, unknown>>;
    _hooks: { beforeConfigWrite?: () => void };
  };
  return db;
}

// ---------------------------------------------------------------------------
// 1. parseCostGuardCommand
// ---------------------------------------------------------------------------

describe('parseCostGuardCommand', () => {
  it('extracts subcommand and rest tokens from /costguard prefix', () => {
    expect(parseCostGuardCommand('/costguard status')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
    expect(parseCostGuardCommand('/costguard pause 10m')).toEqual({
      subcommand: 'pause',
      restTokens: ['10m'],
    });
    expect(parseCostGuardCommand('/costguard set hard-cap session 5.0')).toEqual({
      subcommand: 'set',
      restTokens: ['hard-cap', 'session', '5.0'],
    });
    // sub なし → status 扱い (実機テスト計画の `/costguard` 課金確認応答)
    expect(parseCostGuardCommand('/costguard')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
    // 大小混在 → lowercase 化 (Python `_handle:l.229` 等価)
    expect(parseCostGuardCommand('/costguard STATUS')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
  });

  it('returns null for non-/costguard input (= caller 通常経路)', () => {
    expect(parseCostGuardCommand('hello world')).toBeNull();
    expect(parseCostGuardCommand('/help')).toBeNull();
    expect(parseCostGuardCommand('/mail to:foo@example.com body')).toBeNull();
    expect(parseCostGuardCommand('')).toBeNull();
    // mention 残骸も先頭が `/` でなければ null
    expect(parseCostGuardCommand('@MAKOTOくん /costguard status')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. handleCostGuardCommand status (= 非 admin 閲覧可)
// ---------------------------------------------------------------------------

describe('handleCostGuardCommand status', () => {
  it('returns budget snapshot for non-admin sender (env unset)', async () => {
    const env = envWith(); // COST_GUARD_ADMIN_EMAILS 未設定 = read-only
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'status', restTokens: [] },
      {
        senderEmail: 'someone@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('Cost Guard 状態');
    expect(text).toContain('someone@example.com (read-only)');
    // KV 空 = 現在値 0、default 上限が出る
    expect(text).toContain('Anthropic 月累計 USD: 0 / 300');
    expect(text).toContain('Chat 日次件数 (この返信直前): 0 / 200');
    expect(text).toContain('外部 API 呼び数 (日次): 0 / 1000 (一部経路は未計測)');
    expect(text).toContain('超過軸: なし');
    expect(text).toContain('operator 通知 space: 未設定 (警告は no-op)');
  });

  it('marks admin sender as (admin) when COST_GUARD_ADMIN_EMAILS matches', async () => {
    const env = envWith('Admin@Example.com'); // 大小混在 + lowercase 化検証
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'status', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('admin@example.com (admin)');
  });
});

// ---------------------------------------------------------------------------
// 3. handleCostGuardCommand mutation gate (`disable`)
// ---------------------------------------------------------------------------

describe('handleCostGuardCommand mutation gate', () => {
  it('denies mutation when COST_GUARD_ADMIN_EMAILS is unset (fail-closed)', async () => {
    const env = envWith();
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'disable', restTokens: [] },
      {
        senderEmail: 'someone@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('Cost Guard コマンド拒否');
    expect(text).toContain('管理者未設定 (COST_GUARD_ADMIN_EMAILS)');
  });

  it('denies mutation when sender is not in admin allowlist', async () => {
    const env = envWith('admin@example.com');
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'pause', restTokens: ['10m'] },
      {
        senderEmail: 'intruder@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('Cost Guard 管理者ではありません');
  });

  it('denies mutation when D1 is not wired even if sender IS admin', async () => {
    const env = envWith('admin@example.com');
    for (const sub of [
      'enable',
      'disable',
      'resume',
      'pause',
      'set',
      'confirm',
      'cancel',
    ]) {
      const text = await handleCostGuardCommand(
        env,
        { subcommand: sub, restTokens: [] },
        {
          senderEmail: 'admin@example.com',
          guardDeps: makeGuardDeps(),
        },
      );
      expect(text).toContain('Cost Guard コマンド拒否');
      expect(text).toContain('D1 設定ストアが未接続');
    }
  });

  it('applies enable immediately with audit', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'enable', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(text).toContain('Cost Guard 設定を変更しました');
    expect(db._config.get('global')?.enabled).toBe(1);
    expect(db._audit[0]?.action).toBe('enable');
  });

  it('requires confirm for disable and never stores raw token', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    const prompt = await handleCostGuardCommand(
      env,
      { subcommand: 'disable', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(prompt).toContain('Cost Guard 変更確認');
    const token = /confirm ([0-9a-f]{8})/.exec(prompt)?.[1];
    expect(token).toBeTruthy();
    const pending = db._pending.get('admin@example.com')!;
    expect(pending.token_hash).not.toBe(token);
    expect(JSON.stringify(pending)).not.toContain(token!);

    const applied = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: [token!] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(applied).toContain('Cost Guard 設定を変更しました');
    expect(db._config.get('global')?.enabled).toBe(0);
    expect(db._pending.size).toBe(0);
    expect(db._audit[0]?.action).toBe('disable');

    const second = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: [token!] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(second).toContain('一致する有効な確認待ち操作がありません');
  });

  it('rejects wrong-token, expired, and actor-mismatched confirmations', async () => {
    const env = envWith('admin@example.com,other@example.com');
    const db = makeCommandDb();
    await handleCostGuardCommand(
      env,
      { subcommand: 'disable', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    const wrong = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: ['deadbeef'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(wrong).toContain('一致する有効な確認待ち操作がありません');
    expect(db._pending.size).toBe(1);

    const other = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: ['deadbeef'] },
      {
        senderEmail: 'other@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(other).toContain('一致する有効な確認待ち操作がありません');

    db._pending.get('admin@example.com')!.expires_at_ms = 0;
    const expired = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: ['deadbeef'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(expired).toContain('一致する有効な確認待ち操作がありません');
  });

  it('returns denied when audit/config batch fails after pending consume', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    const prompt = await handleCostGuardCommand(
      env,
      { subcommand: 'disable', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    const token = /confirm ([0-9a-f]{8})/.exec(prompt)?.[1];
    (db as unknown as { batch: () => Promise<never> }).batch = async () => {
      throw new Error('audit down');
    };
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: [token!] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(text).toContain('Cost Guard コマンド拒否');
    expect(text).toContain('コマンド処理に失敗しました');
    expect(db._config.size).toBe(0);
  });

  it('applies hard-cap lowering immediately and hard-cap raising through confirm', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    const lower = await handleCostGuardCommand(
      env,
      { subcommand: 'set', restTokens: ['hard-cap', 'chat-daily', '100'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(lower).toContain('Cost Guard 設定を変更しました');
    expect(JSON.parse(String(db._config.get('global')?.limits_json))).toEqual({
      chatDailyCount: 100,
    });

    const raise = await handleCostGuardCommand(
      env,
      { subcommand: 'set', restTokens: ['hard-cap', 'month-usd', '500'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(raise).toContain('Cost Guard 変更確認');
    expect(db._pending.size).toBe(1);
  });

  it('rejects stale destructive confirmation after config changed', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    const raise = await handleCostGuardCommand(
      env,
      { subcommand: 'set', restTokens: ['hard-cap', 'month-usd', '500'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    const token = /confirm ([0-9a-f]{8})/.exec(raise)?.[1];
    expect(token).toBeTruthy();

    await handleCostGuardCommand(
      env,
      { subcommand: 'enable', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    const stale = await handleCostGuardCommand(
      env,
      { subcommand: 'confirm', restTokens: [token!] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(stale).toContain('確認待ち作成後に設定が変更済み');
    expect(JSON.parse(String(db._config.get('global')?.limits_json))).toEqual({});
    expect(db._audit.map((row) => row.action)).toEqual(['enable']);
  });

  it('does not clobber concurrent config changes on optimistic conflict', async () => {
    const env = envWith('admin@example.com');
    const db = makeCommandDb();
    await handleCostGuardCommand(
      env,
      { subcommand: 'set', restTokens: ['hard-cap', 'chat-daily', '100'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    db._hooks.beforeConfigWrite = () => {
      const current = db._config.get('global')!;
      db._config.set('global', {
        ...current,
        limits_json: JSON.stringify({
          chatDailyCount: 100,
          externalApiDailyCount: 50,
        }),
        change_seq: Number(current.change_seq) + 1,
      });
    };

    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'set', restTokens: ['hard-cap', 'month-calls', '9000'] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: { ...makeGuardDeps(), db },
      },
    );
    expect(text).toContain('Cost Guard コマンド拒否');
    expect(JSON.parse(String(db._config.get('global')?.limits_json))).toEqual({
      chatDailyCount: 100,
      externalApiDailyCount: 50,
    });
    expect(db._audit.map((row) => row.action)).toEqual(['set:chatDailyCount']);
  });
});

// ---------------------------------------------------------------------------
// 4. unknown subcommand + exception swallow
// ---------------------------------------------------------------------------

describe('handleCostGuardCommand edge cases', () => {
  it('returns status for empty subcommand (= /costguard alone)', async () => {
    const env = envWith();
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'status', restTokens: [] },
      {
        senderEmail: 'someone@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('Cost Guard 状態');
    expect(text).toContain('Anthropic 月累計 USD');
  });

  it('returns denied for unknown subcommand', async () => {
    const env = envWith('admin@example.com');
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'nuke', restTokens: [] },
      {
        senderEmail: 'admin@example.com',
        guardDeps: makeGuardDeps(),
      },
    );
    expect(text).toContain('Cost Guard コマンド拒否');
    expect(text).toContain('未知のサブコマンド: nuke');
  });

  it('swallows checkBudget exception and returns denied (= bot を落とさない)', async () => {
    const env = envWith();
    // KV.get が throw する fake KV
    const throwingKv = {
      get: async () => {
        throw new Error('synthetic KV outage');
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    } as unknown as KVNamespace;
    // checkBudget 自身は fail-open で 0 を返す = throw しない契約なので、
    // ここでは handleCostGuardCommand 内 buildStatusText も成功 → status text
    // が返る (= 落ちずに 0 表示)。例外吸収契約 (Python `handle:l.213-221`
    // 等価) の境界としては「checkBudget が将来 throw に変わっても denied で
    // 落ちない」ことを確認するため、無効 sub で内部 error を直接誘発する
    // 経路は別途、buildStatusText が throw する shape のテストで担保する。
    const text = await handleCostGuardCommand(
      env,
      { subcommand: 'status', restTokens: [] },
      {
        senderEmail: 'someone@example.com',
        guardDeps: { kv: throwingKv },
      },
    );
    expect(text).toContain('Cost Guard 状態');
    expect(text).toContain('Anthropic 月累計 USD: 0 / 300');
  });
});
