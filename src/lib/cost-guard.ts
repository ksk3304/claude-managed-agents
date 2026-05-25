/**
 * KV-backed cost guard for the MAKOTOくん bridge.
 *
 * Cloud Run の `scripts/cost_guard/` (Firestore txn + 3 軸 thresholds +
 * /costguard 運用者コマンド) を、Cloudflare Worker 向けに簡素化した KV
 * カウンタ実装。Worker は cold-start が頻繁で Firestore txn の重みを
 * 持たせにくいため、本層は以下に絞る:
 *
 *   1. **カウンタ管理** (KV increment)
 *      - `cost_guard:anthropic_call:<YYYY-MM>` : Anthropic API 呼び数 (月)
 *      - `cost_guard:anthropic_cost_usd:<YYYY-MM>` : Anthropic 月累計 USD
 *      - `cost_guard:chat_post:<YYYY-MM-DD>` : Chat 投稿数 (日)
 *
 *   2. **予算判定** (`checkBudget`) — current vs limit を返すだけの純関数。
 *      caller 側で gating する。
 *
 *   3. **Chat sender wrap** (`wrapChatSender`) — original sender を包み、
 *      予算超過時は **no-op + warning 通知** (Cloud Run 側の register_chat_sender
 *      と同じ思想、`_configure_cost_guard_chat_sender` 等価)。
 *
 * 設計判断:
 *   - **KV 専用**: D1 / Durable Object に依存しない。同一日/月の 2 つの
 *     reactive 経路が同時に increment しても KV の eventual consistency
 *     範囲で吸収する (= Worker 同一 isolate 内 = 単一書込み、cross-isolate
 *     は数秒遅延あり)。budget は **保守側に倒す ≒ 多少多めに数えても OK**
 *     な性質なので KV で十分。
 *   - **外部 fetch しない**: Chat 投稿は wrap 対象の `chatSender` 経由のみ。
 *     egress-guard import 不要 (= caller が既に egress 通過している)。
 *   - **TTL 自動掃除**: 月カウンタは 35 日、日カウンタは 35 日で expire
 *     (Cloudflare KV `expirationTtl`)。古い key の手動削除が不要。
 *   - **fail-open**: KV read/write 例外時はカウンタ無視で進める (Cloud Run
 *     `_handle_check_gate_error` と同じ思想、可用性 > 厳密性)。
 *
 * 内部状態漏洩ガード: warning 通知文面は `.claude/rules/makoto-kun-verification.md`
 * §1.1 の危険語句 (`未 attach` / `memory store` / `参照できず` / `エラーが
 * 発生しました` / `デフォルト値で` 等) を含まないこと。本ファイル内では
 * static 文字列のみで構成して回避する (LLM 出力ではない)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #17)
 * Source: scripts/cost_guard/guard.py (Firestore 版、Cloud Run)
 *         scripts/cma_gchat_bot.py:_configure_cost_guard_chat_sender
 */

const PREFIX = 'cost_guard';

/**
 * Per-month Anthropic API call count (= 呼び数。コスト換算前の生回数)。
 * `incrementCounter(deps, 'anthropic_call', n)` で +n される。
 */
const KIND_ANTHROPIC_CALL = 'anthropic_call';

/**
 * Per-month Anthropic API 累計コスト (USD)。`incrementCounter(deps,
 * 'anthropic_cost_usd', deltaUsd)` で増分。USD は浮動小数点で保持する
 * (KV は文字列 + JSON 経由)。
 */
const KIND_ANTHROPIC_COST_USD = 'anthropic_cost_usd';

/**
 * Per-day Chat 投稿数 (= 頻度上限制御用)。
 */
const KIND_CHAT_POST = 'chat_post';

export type CostKind =
  | typeof KIND_ANTHROPIC_CALL
  | typeof KIND_ANTHROPIC_COST_USD
  | typeof KIND_CHAT_POST;

/** Cloudflare KV `expirationTtl` (seconds). 35 日 = 月跨ぎカウンタの自動掃除に十分。 */
const COUNTER_TTL_SEC = 35 * 24 * 60 * 60;

/**
 * 予算設定 (defaults はテスト容易性のため低めに固定。caller が `deps.limits`
 * で override する想定)。Cloud Run 側の `DEFAULT_THRESHOLDS` 相当だが、
 * KV 層では USD ベース月予算 + 投稿頻度上限の 2 軸に絞る。
 */
export interface CostLimits {
  /** Anthropic 月累計 USD の上限。超えると wrap した chatSender が no-op。 */
  anthropicMonthlyUsd: number;
  /** Chat 投稿の日次上限 (= ループ抑制の安全弁)。 */
  chatDailyCount: number;
}

export const DEFAULT_LIMITS: CostLimits = {
  anthropicMonthlyUsd: 300,
  chatDailyCount: 200,
};

export interface CostGuardDeps {
  /** KV namespace (= Worker binding `COST_GUARD_KV` 等を caller が渡す)。 */
  kv: KVNamespace;
  /**
   * Operator notification space (= COST_GUARD_OPERATOR_SPACE 等価)。
   * 警告通知の宛先 space (`spaces/AAA`)。未設定なら警告は no-op
   * (Cloud Run `resolve_operator_space` 未設定時と同じ挙動)。
   */
  operatorSpace?: string;
  /** 予算 override (default は DEFAULT_LIMITS)。 */
  limits?: Partial<CostLimits>;
  /** clock override (tests)。 */
  now?: () => Date;
}

export interface BudgetStatus {
  /** kind ごとの現在値 (= KV から読んだ生数)。 */
  current: {
    anthropicMonthlyUsd: number;
    chatDailyCount: number;
  };
  /** 解決済み limit。 */
  limit: CostLimits;
  /** 超過軸の名前 (なければ空配列)。 */
  exceeded: Array<'anthropicMonthlyUsd' | 'chatDailyCount'>;
}

/**
 * Caller (chat-api.ts) が渡す Chat 投稿関数の最小 interface。
 * (= ChatApiDeps は import せず疎結合)
 */
export type ChatSender = (spaceName: string, text: string) => Promise<unknown>;

// ----------------------------------------------------------------------------
// 1. Counter increment
// ----------------------------------------------------------------------------

/**
 * KV カウンタを `by` だけ進める。同一 isolate での連続呼出は seq 化
 * (read → +by → write)、cross-isolate 並走は KV の eventual consistency
 * で「やや少なめ」に丸まりうるが、cost guard は保守側に倒す性質 (= 多少
 * 取りこぼしても許容、厳密性より availability) なので CAS は不要。
 *
 * KV write 例外時は throw せずカウンタを進めずに正常 return する
 * (fail-open: 例外で Chat 投稿経路を止めるのが本末転倒)。
 */
export async function incrementCounter(
  deps: CostGuardDeps,
  kind: CostKind,
  by: number,
): Promise<number> {
  if (!Number.isFinite(by) || by < 0) {
    throw new Error(
      `incrementCounter: 'by' must be a non-negative finite number (got ${by})`,
    );
  }
  if (by === 0) {
    return await readCounter(deps, kind);
  }
  const key = buildKey(kind, currentBucket(deps, kind));
  try {
    const prev = await readCounterRaw(deps.kv, key);
    const next = prev + by;
    await deps.kv.put(key, JSON.stringify({ v: next }), {
      expirationTtl: COUNTER_TTL_SEC,
    });
    return next;
  } catch {
    // fail-open: KV 障害でも投稿経路を落とさない
    return Number.NaN;
  }
}

/**
 * 現在のカウンタ値を読む。KV miss は 0。fail-open: KV 例外時は 0 を返す。
 */
export async function readCounter(
  deps: CostGuardDeps,
  kind: CostKind,
): Promise<number> {
  const key = buildKey(kind, currentBucket(deps, kind));
  try {
    return await readCounterRaw(deps.kv, key);
  } catch {
    return 0;
  }
}

async function readCounterRaw(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown };
    const v = parsed?.v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return 0;
  } catch {
    return 0;
  }
}

// ----------------------------------------------------------------------------
// 2. Budget check
// ----------------------------------------------------------------------------

/**
 * 現状値 + limit を返す純関数。caller が `exceeded` を見て gate する。
 *
 * fail-open: KV 障害時は current=0 で返す = 「超過していない」扱いになる
 * (`exceeded=[]`)。
 */
export async function checkBudget(deps: CostGuardDeps): Promise<BudgetStatus> {
  const limit = resolveLimits(deps.limits);
  const [costUsd, chatCount] = await Promise.all([
    readCounter(deps, KIND_ANTHROPIC_COST_USD),
    readCounter(deps, KIND_CHAT_POST),
  ]);
  const current = {
    anthropicMonthlyUsd: costUsd,
    chatDailyCount: chatCount,
  };
  const exceeded: BudgetStatus['exceeded'] = [];
  if (current.anthropicMonthlyUsd >= limit.anthropicMonthlyUsd) {
    exceeded.push('anthropicMonthlyUsd');
  }
  if (current.chatDailyCount >= limit.chatDailyCount) {
    exceeded.push('chatDailyCount');
  }
  return { current, limit, exceeded };
}

// ----------------------------------------------------------------------------
// 3. Chat sender wrap
// ----------------------------------------------------------------------------

export interface WrappedChatSender {
  /**
   * 予算内なら original sender に委譲 + chat_post カウンタ +1。
   * 予算超過時は **no-op + 通知** (= operatorSpace が設定済なら 1 回だけ
   * 警告を投稿、未設定なら警告も no-op)。
   *
   * Cloud Run 側の `register_chat_sender` 配線と等価。
   *
   * 第 3 引数の `bypassGuard=true` は内部 warning 通知用 (= 予算超過で
   * 通常投稿を抑止しているのに、その通知だけは送りたい)。外部 caller は
   * 渡さない。
   */
  (spaceName: string, text: string, bypassGuard?: boolean): Promise<void>;
}

/**
 * `sender` を予算ガード付きで包む。
 *
 * - 予算 OK: sender 呼出 + chat_post カウンタ +1。sender 例外は throw する
 *   (= caller は通常通り扱う)。
 * - 予算 NG: sender は呼ばず、operator space へ警告を 1 回投稿 (重複抑止は
 *   日次 `cost_guard:warning_emitted:<YYYY-MM-DD>` フラグで管理)。
 *   警告投稿自体は bypassGuard=true で進む (= 警告が予算ガードで止まる
 *   循環を防ぐ)。
 */
export function wrapChatSender(
  deps: CostGuardDeps,
  sender: ChatSender,
): WrappedChatSender {
  const wrapped: WrappedChatSender = async (
    spaceName: string,
    text: string,
    bypassGuard?: boolean,
  ) => {
    if (bypassGuard) {
      // 警告通知自身: 予算判定をスキップして直接送る (循環防止)。
      // chat_post カウンタも +1 しない (= 警告分でカウンタを膨らませない)。
      await sender(spaceName, text);
      return;
    }
    const status = await checkBudget(deps);
    if (status.exceeded.length > 0) {
      await maybeNotifyOperator(deps, sender, status);
      return; // no-op (= 予算超過時は通常投稿しない)
    }
    await sender(spaceName, text);
    // 投稿成功後にカウンタ +1 (失敗時は数えない = caller retry 余地を残す)
    await incrementCounter(deps, KIND_CHAT_POST, 1);
  };
  return wrapped;
}

/**
 * 1 日 1 回だけ operator space に警告を投稿する。同日 2 回目以降は no-op。
 * KV フラグ `cost_guard:warning_emitted:<YYYY-MM-DD>` を立てて重複抑止。
 *
 * operatorSpace 未設定なら投稿 no-op (Cloud Run `resolve_operator_space`
 * 未設定時と同じ挙動)。
 */
async function maybeNotifyOperator(
  deps: CostGuardDeps,
  sender: ChatSender,
  status: BudgetStatus,
): Promise<void> {
  const operatorSpace = deps.operatorSpace?.trim();
  if (!operatorSpace) return;

  const dateKey = ymd(now(deps));
  const flagKey = `${PREFIX}:warning_emitted:${dateKey}`;
  let alreadyEmitted = false;
  try {
    const raw = await deps.kv.get(flagKey);
    alreadyEmitted = raw !== null;
  } catch {
    // KV read 失敗時は「未通知」扱いで投稿する (= 通知漏れより重複の方が安全)
    alreadyEmitted = false;
  }
  if (alreadyEmitted) return;

  const text = buildWarningText(status);
  try {
    await sender(operatorSpace, text);
  } catch {
    // 通知失敗は飲み込む (= fail-open。Cloud Run cost_guard_notify_failed と同じ)
    return;
  }
  try {
    await deps.kv.put(flagKey, JSON.stringify({ at: now(deps).toISOString() }), {
      expirationTtl: COUNTER_TTL_SEC,
    });
  } catch {
    // フラグ書込み失敗時は次回も警告が出るが、害は軽微
  }
}

/**
 * 警告文面 (= static 文字列のみ。LLM 出力ではないので makoto-kun-verification
 * §1.1 危険語句リストの混入リスクは構造的にゼロだが、念のため危険語句を
 * 含まない素朴表現で構成)。
 *
 * Cloud Run `build_warning_summary_message` 等価だが、円換算と FireRecord
 * は持たない (= KV 層では簡略化)。
 */
function buildWarningText(status: BudgetStatus): string {
  const lines: string[] = ['Cost Guard 予算超過: 通常の Chat 投稿を抑止しました。'];
  for (const axis of status.exceeded) {
    if (axis === 'anthropicMonthlyUsd') {
      lines.push(
        `- Anthropic 月累計: $${status.current.anthropicMonthlyUsd.toFixed(4)} ` +
          `(上限 $${status.limit.anthropicMonthlyUsd.toFixed(2)})`,
      );
    } else if (axis === 'chatDailyCount') {
      lines.push(
        `- Chat 投稿 (日次): ${status.current.chatDailyCount} 件 ` +
          `(上限 ${status.limit.chatDailyCount} 件)`,
      );
    }
  }
  lines.push('- 次の自動再開: 月跨ぎ / 日跨ぎで自動回復します。');
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function resolveLimits(override: Partial<CostLimits> | undefined): CostLimits {
  return {
    anthropicMonthlyUsd:
      override?.anthropicMonthlyUsd ?? DEFAULT_LIMITS.anthropicMonthlyUsd,
    chatDailyCount: override?.chatDailyCount ?? DEFAULT_LIMITS.chatDailyCount,
  };
}

function now(deps: CostGuardDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/**
 * kind ごとのバケット = 月単位 (anthropic_*) or 日単位 (chat_post)。
 * JST ではなく UTC で固定する (Worker は GMT 動作、日跨ぎ判定の単純化)。
 */
function currentBucket(deps: CostGuardDeps, kind: CostKind): string {
  const d = now(deps);
  if (kind === KIND_CHAT_POST) return ymd(d);
  return ym(d);
}

function buildKey(kind: CostKind, bucket: string): string {
  return `${PREFIX}:${kind}:${bucket}`;
}

function ym(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function ymd(d: Date): string {
  return `${ym(d)}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------------

/**
 * Test 用の key 構築露出 (= テストで直接 KV を覗くため)。
 */
export const _internals = {
  buildKey,
  ym,
  ymd,
  KIND_ANTHROPIC_CALL,
  KIND_ANTHROPIC_COST_USD,
  KIND_CHAT_POST,
  PREFIX,
  COUNTER_TTL_SEC,
};
