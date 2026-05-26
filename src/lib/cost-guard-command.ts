/**
 * `/costguard` 運用者コマンドの決定論短絡 (Issue #186 既知 #2)。
 *
 * Cloud Run `scripts/cost_guard/command.py` を Cloudflare Worker 向けに簡素化
 * した TS port。LLM 経由を一切経由せず Anthropic 課金ゼロで status / 認可
 * チェックを返す ── これが「安全弁の mutation を LLM 推論に委ねない」原則
 * (Python `command.py` モジュール冒頭 docstring 同思想)。
 *
 * 担当範囲 (Phase 2 中間版):
 *
 *   1. **command parse** — `parseCostGuardCommand(text)` で `/costguard <sub>`
 *      を検出し、subcommand 名 + 残り token を返す。先頭分離 regex は既存
 *      `intent-detector.ts:parseCommand` (= Python `parse_command:l.956`) を
 *      再利用 (= 重複 regex を避ける)。
 *
 *   2. **status 応答** — 非 admin でも閲覧可。Worker 側 `cost-guard.ts` の
 *      `checkBudget` (= 月 USD + 日 Chat 件数) を読んで現在値 / 上限 / 超過
 *      軸 / 設定源を 1 つの Chat 投稿用テキストに整形する。Python
 *      `_status_text` (`command.py:l.104-134`) と等価 (= `axes` / `cache_age`
 *      列挙)。
 *
 *   3. **admin gate (mutation 系)** — `enable/disable/resume/pause/set/confirm/
 *      cancel` は env `COST_GUARD_ADMIN_EMAILS` に列挙された email のみ実行
 *      可能 (Python `_is_admin` 等価、未設定なら fail-closed)。**Phase 2 では
 *      mutation 系 subcommand 自体を未実装で 503 (= "未 port") として返す**
 *      (Worker 側に Firestore overlay 永続層が未実装 = 値を書いても次回再起動
 *      で消える。実装してから出すと"動いた風"で安全弁を緩める方が遥かに危険)。
 *      これは Python `_handle:l.224-286` を意図的に縮約した形 (= 既知 #2 で
 *      別 Issue 化候補)。
 *
 *   4. **未知 subcommand** — Python と同様 `denied` 文面を返す (= safe-by-default)。
 *
 * exception はすべて吸収して `denied` 文面を返す (Python `handle` `try/except`
 * と同じ思想、安全弁コマンドは bot を落とさない)。
 */

import { checkBudget, type CostGuardDeps, type BudgetStatus } from './cost-guard';
import { parseCommand } from './intent-detector';

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
  const subcommand = (toks[0] || '').toLowerCase();
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
 * `BudgetStatus` (= 月 USD + 日件数 2 軸) のみを整形する。
 */
function buildStatusText(
  status: BudgetStatus,
  opts: { operatorSpaceConfigured: boolean; admin: boolean; actor: string },
): string {
  const exceededLabel =
    status.exceeded.length === 0 ? 'なし' : status.exceeded.join(', ');
  const lines: string[] = [];
  lines.push('Cost Guard 状態 (KV 経路、Phase 2)');
  lines.push(`- 操作者: ${opts.actor}${opts.admin ? ' (admin)' : ' (read-only)'}`);
  lines.push(
    `- Anthropic 月累計 USD: ${status.current.anthropicMonthlyUsd} / ${status.limit.anthropicMonthlyUsd}`,
  );
  lines.push(
    `- Chat 日次件数: ${status.current.chatDailyCount} / ${status.limit.chatDailyCount}`,
  );
  lines.push(`- 超過軸: ${exceededLabel}`);
  lines.push(`- operator 通知 space: ${opts.operatorSpaceConfigured ? '設定済' : '未設定 (警告は no-op)'}`);
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

  if (!subcommand) {
    return denied(
      'サブコマンド未指定 (status / enable / disable / resume / pause / set / confirm / cancel)',
    );
  }

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

  // Phase 2 中間版では mutation 系 subcommand は未 port (Worker 側 Firestore
  // overlay 永続層が未実装 = 値を書いても次回 isolate 再起動で消える)。
  // Python `_handle:l.242-286` 相当の enable/disable/resume/pause/set/confirm/
  // cancel は別 Issue で port 予定。**「動いた風」で安全弁を緩めるより明示
  // 拒否する** (= safe-by-default、Python `command.py` モジュール冒頭 docstring
  // と同じ思想)。
  const knownMutations = new Set([
    'enable',
    'disable',
    'resume',
    'pause',
    'set',
    'confirm',
    'cancel',
  ]);
  if (knownMutations.has(subcommand)) {
    return denied(
      `subcommand '${subcommand}' は Worker 側で未実装 (Phase 2 では status のみ port、Issue #186 follow-up)`,
    );
  }

  return denied(`未知のサブコマンド: ${subcommand}`);
}
