/**
 * `/costguard` 運用者コマンドの決定論短絡 (Issue #186 既知 #2)。
 *
 * Cloud Run `scripts/cost_guard/command.py` を Cloudflare Worker 向けに簡素化
 * した TS port。LLM 経由を一切経由せず Anthropic 課金ゼロで status / 認可
 * チェックを返す ── これが「安全弁の mutation を LLM 推論に委ねない」原則
 * (Python `command.py` モジュール冒頭 docstring 同思想)。
 *
 * 担当範囲 (Cloudflare mutation 版):
 *
 *   1. **command parse** — `parseCostGuardCommand(text)` で `/costguard <sub>`
 *      を検出し、subcommand 名 + 残り token を返す。先頭分離 regex は既存
 *      `intent-detector.ts:parseCommand` (= Python `parse_command:l.956`) を
 *      再利用 (= 重複 regex を避ける)。
 *
 *   2. **status 応答** — 非 admin でも閲覧可。Worker 側 `cost-guard.ts` の
 *      `checkBudget` (= 月 Anthropic 呼び数 / 月 USD / 日 Chat 件数 / 日外部
 *      API 件数) を読んで現在値 / 上限 / 超過
 *      軸 / 設定源を 1 つの Chat 投稿用テキストに整形する。Python
 *      `_status_text` (`command.py:l.104-134`) と等価 (= `axes` / `cache_age`
 *      列挙)。
 *
 *   3. **admin gate (mutation 系)** — `enable/disable/resume/pause/set/confirm/
 *      cancel` は env `COST_GUARD_ADMIN_EMAILS` に列挙された email のみ実行
 *      可能 (Python `_is_admin` 等価、未設定なら fail-closed)。状態は D1
 *      `cost_guard_config` / `cost_guard_pending` / `cost_guard_audit` に保存し、
 *      disable / pause / hard-cap 引上げは one-shot token confirm を必須にする。
 *
 *   4. **未知 subcommand** — Python と同様 `denied` 文面を返す (= safe-by-default)。
 *
 * exception はすべて吸収して `denied` 文面を返す (Python `handle` `try/except`
 * と同じ思想、安全弁コマンドは bot を落とさない)。
 */

import {
  DEFAULT_LIMITS,
  CostGuardConfigConflictError,
  applyCostGuardConfigPatch,
  checkBudget,
  readCostGuardConfig,
  type BudgetStatus,
  type CostGuardConfigPatch,
  type CostGuardDeps,
  type CostLimitKey,
  type CostLimits,
} from './cost-guard';
import { parseCommand } from './intent-detector';

const PENDING_TTL_MS = 120_000;
const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

type PendingMutation = {
  action: string;
  patch: CostGuardConfigPatch;
  summary: string;
};

type PendingRow = {
  action: string;
  patch_json: string;
  summary: string;
  base_change_seq: number;
  expires_at_ms: number;
};

const AXES: Record<string, { key: CostLimitKey; label: string; unit: string }> = {
  month: { key: 'anthropicMonthlyUsd', label: 'Anthropic 月累計 USD', unit: 'USD' },
  'month-usd': { key: 'anthropicMonthlyUsd', label: 'Anthropic 月累計 USD', unit: 'USD' },
  'month-calls': { key: 'anthropicMonthlyCalls', label: 'Anthropic API 呼び数 (月次)', unit: '件' },
  'chat-daily': { key: 'chatDailyCount', label: 'Chat 投稿 (日次)', unit: '件' },
  'external-api-daily': { key: 'externalApiDailyCount', label: '外部 API 呼び数 (日次)', unit: '件' },
};

/**
 * `/costguard <rest>` を parse する。
 *
 * `/costguard` 以外の slash コマンドは `null` を返す ── caller はこのとき
 * 通常 LLM dispatch 経路に流す (= 短絡しない)。
 *
 * @param text mention strip 済の chat body text
 * @returns `{ subcommand, restTokens }` または `null`
 */
export function parseCostGuardCommand(
  text: string,
): { subcommand: string; restTokens: string[] } | null {
  const [cmd, rest] = parseCommand(text);
  if (cmd !== '/costguard') return null;
  const toks = (rest || '').trim().split(/\s+/).filter((t) => t.length > 0);
  const subcommand = (toks[0] || 'status').toLowerCase();
  const restTokens = toks.slice(1);
  return { subcommand, restTokens };
}

/**
 * `COST_GUARD_ADMIN_EMAILS` env を csv parse して lowercase set にする。
 * Python `_admin_emails:l.50-52` 等価。
 */
function adminEmails(env: Pick<Env, 'COST_GUARD_ADMIN_EMAILS'>): Set<string> {
  const raw = env.COST_GUARD_ADMIN_EMAILS || '';
  const out = new Set<string>();
  for (const e of raw.split(',')) {
    const trimmed = e.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/**
 * 認可判定 (Python `_is_admin:l.55-59` 等価)。env 未設定は fail-closed
 * (admin 0 = mutation 全拒否 = status のみ閲覧可)。
 */
function isAdmin(
  env: Pick<Env, 'COST_GUARD_ADMIN_EMAILS'>,
  senderEmail: string,
): boolean {
  const allow = adminEmails(env);
  if (allow.size === 0) return false;
  return allow.has((senderEmail || '').trim().toLowerCase());
}

/**
 * Python `notify.build_costguard_status_message` の Worker 縮約版。
 * `BudgetStatus` (= Cloudflare D1/KV counters) を整形する。
 */
function buildStatusText(
  status: BudgetStatus,
  opts: { operatorSpaceConfigured: boolean; admin: boolean; actor: string },
): string {
  const exceededLabel =
    status.exceeded.length === 0 ? 'なし' : status.exceeded.join(', ');
  const lines: string[] = [];
  lines.push('Cost Guard 状態 (D1/KV 経路、Phase 4)');
  lines.push(`- 操作者: ${opts.actor}${opts.admin ? ' (admin)' : ' (read-only)'}`);
  lines.push(
    `- Anthropic API 呼び数 (月次): ${status.current.anthropicMonthlyCalls} / ${status.limit.anthropicMonthlyCalls}`,
  );
  lines.push(
    `- Anthropic 月累計 USD: ${status.current.anthropicMonthlyUsd} / ${status.limit.anthropicMonthlyUsd}`,
  );
  lines.push(
    `- Chat 日次件数: ${status.current.chatDailyCount} / ${status.limit.chatDailyCount}`,
  );
  lines.push(
    `- 外部 API 呼び数 (日次): ${status.current.externalApiDailyCount} / ${status.limit.externalApiDailyCount}`,
  );
  lines.push(`- 超過軸: ${exceededLabel}`);
  lines.push(`- 有効状態: ${status.config.enabled ? 'enabled' : 'disabled'}`);
  if (status.config.paused) {
    lines.push(`- 一時停止: ${status.config.pausedUntilIso} まで`);
  }
  lines.push(`- 設定 source: ${status.config.source} / change_seq=${status.config.changeSeq}`);
  lines.push(`- operator 通知 space: ${opts.operatorSpaceConfigured ? '設定済' : '未設定 (警告は no-op)'}`);
  lines.push('- mutation: enable / disable / pause / resume / set hard-cap / confirm / cancel');
  return lines.join('\n');
}

/**
 * `denied` 文面 (Python `notify.build_costguard_denied` 等価)。
 */
function denied(reason: string): string {
  return `❌ Cost Guard コマンド拒否: ${reason}`;
}

/**
 * `/costguard <subcommand>` のハンドラ本体。例外は内部で吸収して `denied`
 * 文面を返す (Python `handle:l.209-221` と同じ契約)。
 *
 * @param env Worker env (`COST_GUARD_ADMIN_EMAILS` を読む)
 * @param command `parseCostGuardCommand` の戻り値
 * @param opts.senderEmail 発信者 email (admin 判定に使う)
 * @param opts.guardDeps `cost-guard.ts:checkBudget` に渡す deps
 * @returns Chat 投稿用テキスト
 */
export async function handleCostGuardCommand(
  env: Pick<Env, 'COST_GUARD_ADMIN_EMAILS'>,
  command: { subcommand: string; restTokens: string[] },
  opts: {
    senderEmail: string;
    guardDeps: CostGuardDeps;
  },
): Promise<string> {
  try {
    return await handleInner(env, command, opts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[cost-guard-command] failed: ${reason}`);
    return denied('コマンド処理に失敗しました (ログ参照)');
  }
}

async function handleInner(
  env: Pick<Env, 'COST_GUARD_ADMIN_EMAILS'>,
  command: { subcommand: string; restTokens: string[] },
  opts: {
    senderEmail: string;
    guardDeps: CostGuardDeps;
  },
): Promise<string> {
  const { subcommand } = command;
  const { senderEmail, guardDeps } = opts;

  if (subcommand === 'status') {
    // status は閲覧 = 非 admin でも可 (Python `_handle:l.231-232` と同じ)
    const status = await checkBudget(guardDeps);
    return buildStatusText(status, {
      operatorSpaceConfigured: Boolean(guardDeps.operatorSpace?.trim()),
      admin: isAdmin(env, senderEmail),
      actor: senderEmail || '(unknown)',
    });
  }

  // mutation 系 = admin 必須 (Python `_handle:l.234-240` 等価)
  if (!isAdmin(env, senderEmail)) {
    if (adminEmails(env).size === 0) {
      return denied(
        '管理者未設定 (COST_GUARD_ADMIN_EMAILS) のため status 以外は実行不可',
      );
    }
    return denied('あなたは Cost Guard 管理者ではありません (status のみ閲覧可)');
  }

  const mutationCommands = new Set([
    'enable',
    'disable',
    'resume',
    'pause',
    'set',
    'confirm',
    'cancel',
    'warning',
  ]);
  if (!mutationCommands.has(subcommand)) {
    return denied(`未知のサブコマンド: ${subcommand}`);
  }
  if (subcommand === 'warning') {
    return denied('warning 変更は Cloudflare 版では未対応 (#191/#212 scope 外)');
  }
  if (!guardDeps.db) {
    return denied('D1 設定ストアが未接続のため mutation は実行不可');
  }

  const nowMs = Date.now();
  if (subcommand === 'enable') {
    return applyImmediate(guardDeps, senderEmail, nowMs, {
      action: 'enable',
      patch: { enabled: true, pausedUntilMs: null },
      summary: 'Cost Guard を有効化',
    });
  }
  if (subcommand === 'resume') {
    return applyImmediate(guardDeps, senderEmail, nowMs, {
      action: 'resume',
      patch: { pausedUntilMs: null },
      summary: 'Cost Guard の一時停止を解除',
    });
  }
  if (subcommand === 'disable') {
    return createPending(guardDeps, senderEmail, nowMs, {
      action: 'disable',
      patch: { enabled: false },
      summary: 'Cost Guard を無効化',
    });
  }
  if (subcommand === 'pause') {
    const duration = parseDurationMs(command.restTokens[0]);
    if (duration === null) return denied('pause は 1m / 2h / 3d 形式、上限 30d');
    const pausedUntilMs = nowMs + duration;
    return createPending(guardDeps, senderEmail, nowMs, {
      action: 'pause',
      patch: { pausedUntilMs },
      summary: `Cost Guard を ${new Date(pausedUntilMs).toISOString()} まで一時停止`,
    });
  }
  if (subcommand === 'set') {
    return handleSet(guardDeps, senderEmail, nowMs, command.restTokens);
  }
  if (subcommand === 'confirm') {
    return handleConfirm(guardDeps, senderEmail, nowMs, command.restTokens[0]);
  }
  if (subcommand === 'cancel') {
    return handleCancel(guardDeps.db, senderEmail);
  }
  return denied(`未知のサブコマンド: ${subcommand}`);
}

async function applyImmediate(
  deps: CostGuardDeps,
  actorEmail: string,
  nowMs: number,
  mutation: PendingMutation,
): Promise<string> {
  await applyCostGuardConfigPatch(deps, {
    actorEmail,
    action: mutation.action,
    patch: mutation.patch,
    nowMs,
    detail: mutation.summary,
  });
  return buildAppliedText(mutation.summary);
}

async function handleSet(
  deps: CostGuardDeps,
  actorEmail: string,
  nowMs: number,
  tokens: string[],
): Promise<string> {
  const [field, axisRaw, valueRaw] = tokens;
  if (field !== 'hard-cap') {
    return denied('set は `set hard-cap <axis> <value>` のみ対応');
  }
  const axis = AXES[(axisRaw || '').toLowerCase()];
  if (!axis) {
    return denied('axis は month-usd / month-calls / chat-daily / external-api-daily');
  }
  const value = parsePositiveNumber(valueRaw);
  if (value === null) return denied('hard-cap value は正の有限数');
  const patch: CostGuardConfigPatch = { limits: { [axis.key]: value } };
  const status = await checkBudget(deps);
  const current = status.limit[axis.key] ?? DEFAULT_LIMITS[axis.key];
  const summary = `${axis.label} hard-cap を ${formatValue(value, axis.unit)} に変更`;
  if (value <= current) {
    return applyImmediate(deps, actorEmail, nowMs, {
      action: `set:${axis.key}`,
      patch,
      summary,
    });
  }
  return createPending(deps, actorEmail, nowMs, {
    action: `set:${axis.key}`,
    patch,
    summary: `${summary} (引上げ)`,
  }, status.config.changeSeq);
}

async function handleConfirm(
  deps: CostGuardDeps,
  actorEmail: string,
  nowMs: number,
  token: string | undefined,
): Promise<string> {
  if (!token) return denied('confirm token が必要です');
  const row = await consumePending(deps.db!, actorEmail, await hashToken(token), nowMs);
  if (!row) return denied('一致する有効な確認待ち操作がありません');
  const parsed = JSON.parse(row.patch_json) as CostGuardConfigPatch;
  try {
    await applyCostGuardConfigPatch(deps, {
      actorEmail,
      action: row.action,
      patch: parsed,
      nowMs,
      detail: row.summary,
      expectedChangeSeq: Number(row.base_change_seq),
    });
  } catch (err) {
    if (err instanceof CostGuardConfigConflictError) {
      return denied('確認待ち作成後に設定が変更済みです。再度 /costguard から実行してください');
    }
    throw err;
  }
  return buildAppliedText(row.summary);
}

async function handleCancel(db: D1Database, actorEmail: string): Promise<string> {
  const result = await db
    .prepare(`DELETE FROM cost_guard_pending WHERE actor_email = ?`)
    .bind(normaliseEmail(actorEmail))
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  return changes > 0
    ? 'Cost Guard 確認待ち操作を取り消しました。'
    : 'Cost Guard 確認待ち操作はありません。';
}

async function createPending(
  deps: CostGuardDeps,
  actorEmail: string,
  nowMs: number,
  mutation: PendingMutation,
  baseChangeSeq?: number,
): Promise<string> {
  const db = deps.db!;
  const changeSeq = baseChangeSeq ?? (await readCostGuardConfig({ db })).changeSeq;
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO cost_guard_pending
        (actor_email, token_hash, action, patch_json, summary, base_change_seq, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_email) DO UPDATE SET
        token_hash = excluded.token_hash,
        action = excluded.action,
        patch_json = excluded.patch_json,
        summary = excluded.summary,
        base_change_seq = excluded.base_change_seq,
        created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms`,
    )
    .bind(
      normaliseEmail(actorEmail),
      await hashToken(token),
      mutation.action,
      JSON.stringify(mutation.patch),
      mutation.summary,
      changeSeq,
      nowMs,
      nowMs + PENDING_TTL_MS,
    )
    .run();
  return [
    'Cost Guard 変更確認:',
    `- 操作: ${mutation.summary}`,
    `- 確定: /costguard confirm ${token}`,
    '- 取消: /costguard cancel',
    '- 期限: 120秒',
  ].join('\n');
}

async function consumePending(
  db: D1Database,
  actorEmail: string,
  tokenHash: string,
  nowMs: number,
): Promise<PendingRow | null> {
  return await db
    .prepare(
      `DELETE FROM cost_guard_pending
       WHERE actor_email = ? AND token_hash = ? AND expires_at_ms > ?
       RETURNING action, patch_json, summary, base_change_seq, expires_at_ms`,
    )
    .bind(normaliseEmail(actorEmail), tokenHash, nowMs)
    .first<PendingRow>();
}

function buildAppliedText(summary: string): string {
  return [
    'Cost Guard 設定を変更しました。',
    `- 操作: ${summary}`,
    '- 反映: この Worker は即時、他 isolate は次回 read 時',
    '- 緊急停止の最終手段: COST_GUARD_ENABLED=false',
  ].join('\n');
}

function parseDurationMs(raw: string | undefined): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(raw || '');
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = n * scale;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_PAUSE_MS ? ms : null;
}

function parsePositiveNumber(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatValue(value: number, unit: string): string {
  return unit === 'USD' ? `$${value}` : `${value} ${unit}`;
}

function normaliseEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function randomToken(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
