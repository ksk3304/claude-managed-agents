/**
 * Cloudflare-backed cost guard for the MAKOTOくん bridge.
 *
 * Cloud Run の `scripts/cost_guard/` (Firestore txn + 3 軸 thresholds +
 * /costguard 運用者コマンド) を、Cloudflare Worker 向けに簡素化した KV
 * カウンタ実装。D1 を authoritative counter store にし、D1 が使えない
 * 場合だけ KV に fail-open fallback する。本層は以下に絞る:
 *
 *   1. **カウンタ管理** (KV increment)
 *      - `anthropic_call:<YYYY-MM>` : Anthropic API 呼び数 (月)
 *      - `anthropic_cost_usd:<YYYY-MM>` : Anthropic 月累計 USD
 *      - `chat_post:<YYYY-MM-DD>` : Chat 投稿数 (日)
 *      - `external_api_call:<YYYY-MM-DD>` : 外部 API 呼び数 (日)
 *
 *   2. **予算判定** (`checkBudget`) — current vs limit を返すだけの純関数。
 *      caller 側で gating する。
 *
 *   3. **Chat sender wrap** (`wrapChatSender`) — original sender を包み、
 *      予算超過時は **no-op + warning 通知** (Cloud Run 側の register_chat_sender
 *      と同じ思想、`_configure_cost_guard_chat_sender` 等価)。
 *
 * 設計判断:
 *   - **D1 優先 + KV fallback**: D1 `cost_guard_counters` があれば
 *     `INSERT ... ON CONFLICT DO UPDATE` で atomic increment。migration 未適用 /
 *     D1 障害時は既存 KV key に fallback し、Chat 経路の可用性を優先する。
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

/**
 * Per-day 外部 API 呼び数。現時点では foundation counter で、各 tool / egress
 * 経路から段階的に `incrementCounter(..., 'external_api_call', 1)` を足す。
 */
const KIND_EXTERNAL_API_CALL = 'external_api_call';

export type CostKind =
  | typeof KIND_ANTHROPIC_CALL
  | typeof KIND_ANTHROPIC_COST_USD
  | typeof KIND_CHAT_POST
  | typeof KIND_EXTERNAL_API_CALL;

/** Cloudflare KV `expirationTtl` (seconds). 35 日 = 月跨ぎカウンタの自動掃除に十分。 */
const COUNTER_TTL_SEC = 35 * 24 * 60 * 60;

/**
 * 予算設定 (defaults はテスト容易性のため低めに固定。caller が `deps.limits`
 * で override する想定)。Cloud Run 側の `DEFAULT_THRESHOLDS` 相当だが、
 * KV 層では USD ベース月予算 + 投稿頻度上限の 2 軸に絞る。
 */
export interface CostLimits {
  /** Anthropic 月 API 呼び数の上限。 */
  anthropicMonthlyCalls: number;
  /** Anthropic 月累計 USD の上限。超えると wrap した chatSender が no-op。 */
  anthropicMonthlyUsd: number;
  /** Chat 投稿の日次上限 (= ループ抑制の安全弁)。 */
  chatDailyCount: number;
  /** 外部 API 呼び数の日次上限。 */
  externalApiDailyCount: number;
}

export const DEFAULT_LIMITS: CostLimits = {
  anthropicMonthlyCalls: 10_000,
  anthropicMonthlyUsd: 300,
  chatDailyCount: 200,
  externalApiDailyCount: 1_000,
};

export interface CostGuardDeps {
  /** D1 database. If present, counters are read/written here first. */
  db?: D1Database;
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

export interface SessionCostGuardConfig {
  /** 確認する USD 段階。既定: 8,12,16。 */
  thresholdsUsd: number[];
  /** 最後の明示段階以降の増分。既定: 4 (= 20,24,28...). */
  stepUsd: number;
  /** Chat 表示用の概算円換算。既定: 155。 */
  usdToJpy: number;
  /** usage に model が無い時の保守的な価格表 fallback。 */
  fallbackModel: string;
}

export interface SessionCostGuardDeps {
  kv: KVNamespace;
  now?: () => Date;
  config?: Partial<SessionCostGuardConfig>;
}

export interface SessionUsageSnapshot {
  usage: Record<string, unknown> | null | undefined;
  model?: string | null;
}

export interface SessionCostPromptResult {
  promptText: string;
  sessionUsd: number;
  thresholdUsd: number;
  nextThresholdUsd: number;
}

export interface PdfSessionCostProjectionInput {
  threadSessionKey: string | null;
  estimatedCostLowUsd: number | null;
  estimatedCostHighUsd: number | null;
  totalPages: number | null;
  estimatedTokensLow: number | null;
  estimatedTokensHigh: number | null;
}

export interface PdfSessionCostProjectionResult {
  sessionId: string | null;
  currentSessionUsd: number;
  approvedThroughUsd: number;
  nextThresholdUsd: number;
  crossedThresholdUsd: number | null;
  projectedLowUsd: number | null;
  projectedHighUsd: number | null;
  promptText: string | null;
}

export type PendingSessionApprovalResult =
  | { kind: 'none' }
  | { kind: 'reply'; text: string; closeSession: boolean };

export interface BudgetStatus {
  /** kind ごとの現在値 (= KV から読んだ生数)。 */
  current: {
    anthropicMonthlyCalls: number;
    anthropicMonthlyUsd: number;
    chatDailyCount: number;
    externalApiDailyCount: number;
  };
  /** 解決済み limit。 */
  limit: CostLimits;
  /** 超過軸の名前 (なければ空配列)。 */
  exceeded: Array<
    | 'anthropicMonthlyCalls'
    | 'anthropicMonthlyUsd'
    | 'chatDailyCount'
    | 'externalApiDailyCount'
  >;
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
  const bucket = currentBucket(deps, kind);
  if (deps.db) {
    try {
      return await incrementD1Counter(deps.db, kind, bucket, by, now(deps).getTime());
    } catch {
      // D1 unavailable or migration missing: fall back to KV.
    }
  }
  const key = buildKey(kind, bucket);
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
  const bucket = currentBucket(deps, kind);
  if (deps.db) {
    try {
      return await readD1Counter(deps.db, kind, bucket);
    } catch {
      // D1 unavailable or migration missing: fall back to KV.
    }
  }
  const key = buildKey(kind, bucket);
  try {
    return await readCounterRaw(deps.kv, key);
  } catch {
    return 0;
  }
}

async function incrementD1Counter(
  db: D1Database,
  kind: CostKind,
  bucket: string,
  by: number,
  nowMs: number,
): Promise<number> {
  const expireAtMs = nowMs + COUNTER_TTL_SEC * 1000;
  const row = await db
    .prepare(
      `INSERT INTO cost_guard_counters
        (kind, bucket, value, updated_at_ms, expire_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, bucket) DO UPDATE SET
        value = value + excluded.value,
        updated_at_ms = excluded.updated_at_ms,
        expire_at_ms = excluded.expire_at_ms
       RETURNING value`,
    )
    .bind(kind, bucket, by, nowMs, expireAtMs)
    .first<{ value: number }>();
  const value = row?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

async function readD1Counter(
  db: D1Database,
  kind: CostKind,
  bucket: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM cost_guard_counters WHERE kind = ? AND bucket = ?`)
    .bind(kind, bucket)
    .first<{ value: number }>();
  const value = row?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  const [anthropicCalls, costUsd, chatCount, externalApiCount] = await Promise.all([
    readCounter(deps, KIND_ANTHROPIC_CALL),
    readCounter(deps, KIND_ANTHROPIC_COST_USD),
    readCounter(deps, KIND_CHAT_POST),
    readCounter(deps, KIND_EXTERNAL_API_CALL),
  ]);
  const current = {
    anthropicMonthlyCalls: anthropicCalls,
    anthropicMonthlyUsd: costUsd,
    chatDailyCount: chatCount,
    externalApiDailyCount: externalApiCount,
  };
  const exceeded: BudgetStatus['exceeded'] = [];
  if (current.anthropicMonthlyCalls >= limit.anthropicMonthlyCalls) {
    exceeded.push('anthropicMonthlyCalls');
  }
  if (current.anthropicMonthlyUsd >= limit.anthropicMonthlyUsd) {
    exceeded.push('anthropicMonthlyUsd');
  }
  if (current.chatDailyCount >= limit.chatDailyCount) {
    exceeded.push('chatDailyCount');
  }
  if (current.externalApiDailyCount >= limit.externalApiDailyCount) {
    exceeded.push('externalApiDailyCount');
  }
  return { current, limit, exceeded };
}

// ----------------------------------------------------------------------------
// 2b. Per-session staged approval
// ----------------------------------------------------------------------------

const SESSION_STATE_TTL_SEC = 35 * 24 * 60 * 60;
const SESSION_PENDING_TTL_SEC = 24 * 60 * 60;

const DEFAULT_SESSION_CONFIG: SessionCostGuardConfig = {
  thresholdsUsd: [8, 12, 16],
  stepUsd: 4,
  usdToJpy: 155,
  fallbackModel: 'claude-opus-4-7',
};

const PRICING_USD_PER_MTOK: Record<
  string,
  {
    input: number;
    output: number;
    cache_creation: number;
    cache_creation_1h: number;
    cache_read: number;
  }
> = {
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cache_creation: 6.25,
    cache_creation_1h: 10,
    cache_read: 0.5,
  },
  'claude-opus-4-6': {
    input: 5,
    output: 25,
    cache_creation: 6.25,
    cache_creation_1h: 10,
    cache_read: 0.5,
  },
  'claude-opus-4-5': {
    input: 5,
    output: 25,
    cache_creation: 6.25,
    cache_creation_1h: 10,
    cache_read: 0.5,
  },
  'claude-opus-4-1': {
    input: 15,
    output: 75,
    cache_creation: 18.75,
    cache_creation_1h: 30,
    cache_read: 1.5,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cache_creation: 3.75,
    cache_creation_1h: 6,
    cache_read: 0.3,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cache_creation: 1.25,
    cache_creation_1h: 2,
    cache_read: 0.1,
  },
};

interface SessionCostState {
  sessionId: string;
  approvedThroughUsd: number;
  lastSeenUsd: number;
}

interface PendingSessionApproval {
  sessionId: string;
  thresholdUsd: number;
  currentUsd: number;
  nextThresholdUsd: number;
  createdAt: string;
}

export function resolveSessionCostGuardConfig(
  env?: Partial<
    Pick<
      Env,
      | 'COST_GUARD_SESSION_THRESHOLDS_USD'
      | 'COST_GUARD_SESSION_STEP_USD'
      | 'COST_GUARD_USD_TO_JPY'
      | 'COST_GUARD_SESSION_PRICING_MODEL'
    >
  >,
): SessionCostGuardConfig {
  const thresholds = parseNumberList(env?.COST_GUARD_SESSION_THRESHOLDS_USD)
    ?? DEFAULT_SESSION_CONFIG.thresholdsUsd;
  return {
    thresholdsUsd: thresholds,
    stepUsd: positiveNumber(env?.COST_GUARD_SESSION_STEP_USD)
      ?? DEFAULT_SESSION_CONFIG.stepUsd,
    usdToJpy: positiveNumber(env?.COST_GUARD_USD_TO_JPY)
      ?? DEFAULT_SESSION_CONFIG.usdToJpy,
    fallbackModel:
      (env?.COST_GUARD_SESSION_PRICING_MODEL || '').trim()
      || DEFAULT_SESSION_CONFIG.fallbackModel,
  };
}

export async function handlePendingSessionApproval(
  deps: SessionCostGuardDeps,
  input: {
    threadSessionKey: string | null;
    text: string;
  },
): Promise<PendingSessionApprovalResult> {
  if (!input.threadSessionKey) return { kind: 'none' };
  const pending = await readPendingApproval(deps.kv, input.threadSessionKey);
  if (!pending) return { kind: 'none' };

  const decision = parseApprovalDecision(input.text);
  if (decision === 'yes') {
    const state = await readSessionState(deps.kv, pending.sessionId);
    const nextState: SessionCostState = {
      sessionId: pending.sessionId,
      approvedThroughUsd: Math.max(
        state?.approvedThroughUsd ?? 0,
        pending.thresholdUsd,
      ),
      lastSeenUsd: Math.max(state?.lastSeenUsd ?? 0, pending.currentUsd),
    };
    await writeSessionState(deps.kv, nextState);
    await deps.kv.delete(pendingApprovalKey(input.threadSessionKey));
    return {
      kind: 'reply',
      closeSession: false,
      text:
        `了解です。この session を続行します。\n` +
        `次は $${formatUsd(pending.nextThresholdUsd)} 到達時に確認します。`,
    };
  }
  if (decision === 'no') {
    await deps.kv.delete(pendingApprovalKey(input.threadSessionKey));
    await deps.kv.delete(input.threadSessionKey);
    return {
      kind: 'reply',
      closeSession: true,
      text:
        '了解です。この session は終了扱いにしました。\n' +
        '次の発話は新しい session で開始します。',
    };
  }
  return {
    kind: 'reply',
    closeSession: false,
    text: buildSessionApprovalPrompt(pending, resolveConfig(deps)),
  };
}

export async function evaluateSessionCostAfterTurn(
  deps: SessionCostGuardDeps,
  input: {
    threadSessionKey: string | null;
    sessionId: string;
    snapshot: SessionUsageSnapshot;
    approvedThroughUsdFloor?: number | null;
  },
): Promise<SessionCostPromptResult | null> {
  if (!input.threadSessionKey) return null;
  const config = resolveConfig(deps);
  const sessionUsd = usdFromUsage(input.snapshot.usage, input.snapshot.model, config);
  if (sessionUsd === null) return null;

  const prev = await readSessionState(deps.kv, input.sessionId);
  const lastSeenUsd = prev?.lastSeenUsd ?? 0;
  const deltaUsd = Math.max(0, sessionUsd - lastSeenUsd);
  if (deltaUsd > 0) {
    await incrementCounter(
      { kv: deps.kv, now: deps.now },
      KIND_ANTHROPIC_COST_USD,
      deltaUsd,
    );
  }

  const approvedThroughUsd = Math.max(
    prev?.approvedThroughUsd ?? 0,
    input.approvedThroughUsdFloor ?? 0,
  );
  const thresholdUsd = crossedThreshold(sessionUsd, approvedThroughUsd, config);
  const nextState: SessionCostState = {
    sessionId: input.sessionId,
    approvedThroughUsd,
    lastSeenUsd: Math.max(lastSeenUsd, sessionUsd),
  };
  await writeSessionState(deps.kv, nextState);

  if (thresholdUsd === null) return null;

  const nextThresholdUsd = nextThresholdAfter(thresholdUsd, config);
  const pending: PendingSessionApproval = {
    sessionId: input.sessionId,
    thresholdUsd,
    currentUsd: sessionUsd,
    nextThresholdUsd,
    createdAt: now(deps).toISOString(),
  };
  await deps.kv.put(
    pendingApprovalKey(input.threadSessionKey),
    JSON.stringify(pending),
    { expirationTtl: SESSION_PENDING_TTL_SEC },
  );

  return {
    promptText: buildSessionApprovalPrompt(pending, config),
    sessionUsd,
    thresholdUsd,
    nextThresholdUsd,
  };
}

export async function projectSessionCostForPdfPreflight(
  deps: SessionCostGuardDeps,
  input: PdfSessionCostProjectionInput,
): Promise<PdfSessionCostProjectionResult | null> {
  if (!input.threadSessionKey || input.estimatedCostHighUsd === null) return null;
  const config = resolveConfig(deps);
  let sessionId: string | null = null;
  try {
    sessionId = await deps.kv.get(input.threadSessionKey);
  } catch {
    sessionId = null;
  }
  const state = sessionId ? await readSessionState(deps.kv, sessionId) : null;
  const currentSessionUsd = state?.lastSeenUsd ?? 0;
  const approvedThroughUsd = state?.approvedThroughUsd ?? 0;
  const projectedLowUsd = input.estimatedCostLowUsd === null
    ? null
    : currentSessionUsd + input.estimatedCostLowUsd;
  const projectedHighUsd = currentSessionUsd + input.estimatedCostHighUsd;
  const crossedThresholdUsd = crossedThreshold(
    projectedHighUsd,
    approvedThroughUsd,
    config,
  );
  const nextThresholdUsd = crossedThresholdUsd === null
    ? nextThresholdToWatch(approvedThroughUsd, config)
    : crossedThresholdUsd;
  const result: PdfSessionCostProjectionResult = {
    sessionId,
    currentSessionUsd,
    approvedThroughUsd,
    nextThresholdUsd,
    crossedThresholdUsd,
    projectedLowUsd,
    projectedHighUsd,
    promptText: null,
  };
  if (crossedThresholdUsd === null) return result;
  return {
    ...result,
    promptText: buildPdfSessionCostPrompt(input, result),
  };
}

export function usdFromUsage(
  usage: Record<string, unknown> | null | undefined,
  model: string | null | undefined,
  config: SessionCostGuardConfig = DEFAULT_SESSION_CONFIG,
): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const pricing = pricingForModel(model || config.fallbackModel, config);
  if (!pricing) return null;
  const inputTokens = safeTokenCount(usage.input_tokens);
  const outputTokens = safeTokenCount(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const [cache5mTokens, cache1hTokens] = cacheCreationTokens(usage);
  const cacheReadTokens = safeTokenCount(usage.cache_read_input_tokens) ?? 0;
  return (
    inputTokens * pricing.input / 1_000_000 +
    outputTokens * pricing.output / 1_000_000 +
    cache5mTokens * pricing.cache_creation / 1_000_000 +
    cache1hTokens * pricing.cache_creation_1h / 1_000_000 +
    cacheReadTokens * pricing.cache_read / 1_000_000
  );
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
    } else if (axis === 'anthropicMonthlyCalls') {
      lines.push(
        `- Anthropic API 呼び数 (月次): ${status.current.anthropicMonthlyCalls} 件 ` +
          `(上限 ${status.limit.anthropicMonthlyCalls} 件)`,
      );
    } else if (axis === 'chatDailyCount') {
      lines.push(
        `- Chat 投稿 (日次): ${status.current.chatDailyCount} 件 ` +
          `(上限 ${status.limit.chatDailyCount} 件)`,
      );
    } else if (axis === 'externalApiDailyCount') {
      lines.push(
        `- 外部 API 呼び数 (日次): ${status.current.externalApiDailyCount} 件 ` +
          `(上限 ${status.limit.externalApiDailyCount} 件)`,
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
    anthropicMonthlyCalls:
      override?.anthropicMonthlyCalls ?? DEFAULT_LIMITS.anthropicMonthlyCalls,
    anthropicMonthlyUsd:
      override?.anthropicMonthlyUsd ?? DEFAULT_LIMITS.anthropicMonthlyUsd,
    chatDailyCount: override?.chatDailyCount ?? DEFAULT_LIMITS.chatDailyCount,
    externalApiDailyCount:
      override?.externalApiDailyCount ?? DEFAULT_LIMITS.externalApiDailyCount,
  };
}

function resolveConfig(deps: SessionCostGuardDeps): SessionCostGuardConfig {
  const override = deps.config ?? {};
  const thresholds = sanitiseThresholds(override.thresholdsUsd)
    ?? DEFAULT_SESSION_CONFIG.thresholdsUsd;
  return {
    thresholdsUsd: thresholds,
    stepUsd:
      typeof override.stepUsd === 'number' && override.stepUsd > 0
        ? override.stepUsd
        : DEFAULT_SESSION_CONFIG.stepUsd,
    usdToJpy:
      typeof override.usdToJpy === 'number' && override.usdToJpy > 0
        ? override.usdToJpy
        : DEFAULT_SESSION_CONFIG.usdToJpy,
    fallbackModel:
      override.fallbackModel?.trim() || DEFAULT_SESSION_CONFIG.fallbackModel,
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
  if (kind === KIND_CHAT_POST || kind === KIND_EXTERNAL_API_CALL) return ymd(d);
  return ym(d);
}

function buildKey(kind: CostKind, bucket: string): string {
  return `${PREFIX}:${kind}:${bucket}`;
}

function sessionStateKey(sessionId: string): string {
  return `${PREFIX}:session_state:${sessionId}`;
}

function pendingApprovalKey(threadSessionKey: string): string {
  return `${PREFIX}:session_pending:${threadSessionKey}`;
}

async function readSessionState(
  kv: KVNamespace,
  sessionId: string,
): Promise<SessionCostState | null> {
  try {
    const raw = await kv.get(sessionStateKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionCostState>;
    if (parsed.sessionId !== sessionId) return null;
    return {
      sessionId,
      approvedThroughUsd: finiteNumber(parsed.approvedThroughUsd) ?? 0,
      lastSeenUsd: finiteNumber(parsed.lastSeenUsd) ?? 0,
    };
  } catch {
    return null;
  }
}

async function writeSessionState(
  kv: KVNamespace,
  state: SessionCostState,
): Promise<void> {
  try {
    await kv.put(sessionStateKey(state.sessionId), JSON.stringify(state), {
      expirationTtl: SESSION_STATE_TTL_SEC,
    });
  } catch {
    // fail-open: guard state write failure must not stop Chat.
  }
}

async function readPendingApproval(
  kv: KVNamespace,
  threadSessionKey: string,
): Promise<PendingSessionApproval | null> {
  try {
    const raw = await kv.get(pendingApprovalKey(threadSessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSessionApproval>;
    if (!parsed.sessionId) return null;
    const thresholdUsd = finiteNumber(parsed.thresholdUsd);
    const currentUsd = finiteNumber(parsed.currentUsd);
    const nextThresholdUsd = finiteNumber(parsed.nextThresholdUsd);
    if (
      thresholdUsd === null ||
      currentUsd === null ||
      nextThresholdUsd === null
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      thresholdUsd,
      currentUsd,
      nextThresholdUsd,
      createdAt: parsed.createdAt || '',
    };
  } catch {
    return null;
  }
}

function crossedThreshold(
  currentUsd: number,
  approvedThroughUsd: number,
  config: SessionCostGuardConfig,
): number | null {
  let crossed: number | null = null;
  for (const threshold of thresholdsUpTo(currentUsd, config)) {
    if (threshold > approvedThroughUsd && currentUsd >= threshold) {
      crossed = threshold;
    }
  }
  return crossed;
}

function thresholdsUpTo(
  currentUsd: number,
  config: SessionCostGuardConfig,
): number[] {
  const out = [...config.thresholdsUsd];
  let cursor = out[out.length - 1] ?? 0;
  while (cursor + config.stepUsd <= currentUsd) {
    cursor += config.stepUsd;
    out.push(cursor);
  }
  return out;
}

function nextThresholdAfter(
  thresholdUsd: number,
  config: SessionCostGuardConfig,
): number {
  for (const t of config.thresholdsUsd) {
    if (t > thresholdUsd) return t;
  }
  const last = config.thresholdsUsd[config.thresholdsUsd.length - 1] ?? 0;
  if (thresholdUsd < last) return last;
  return thresholdUsd + config.stepUsd;
}

function nextThresholdToWatch(
  approvedThroughUsd: number,
  config: SessionCostGuardConfig,
): number {
  for (const t of config.thresholdsUsd) {
    if (t > approvedThroughUsd) return t;
  }
  const last = config.thresholdsUsd[config.thresholdsUsd.length - 1] ?? 0;
  return Math.max(last, approvedThroughUsd) + config.stepUsd;
}

function buildPdfSessionCostPrompt(
  input: PdfSessionCostProjectionInput,
  projection: PdfSessionCostProjectionResult,
): string {
  return [
    'PDF事前確認',
    'このPDFをこのまま読むと、この会話 session のCost Guard確認ラインに到達する可能性があります。',
    '',
    `- PDF: ${input.totalPages ?? '不明'}ページ`,
    `- 入力token概算: ${formatTokenRange(input.estimatedTokensLow, input.estimatedTokensHigh)}`,
    `- PDF読取コスト概算: ${formatUsdNullable(input.estimatedCostLowUsd)}-${formatUsdNullable(input.estimatedCostHighUsd)}`,
    `- 現在session累計: $${formatUsd(projection.currentSessionUsd)}`,
    `- 読取後見込み: ${formatUsdNullable(projection.projectedLowUsd)}-${formatUsdNullable(projection.projectedHighUsd)}`,
    `- 次の確認ライン: $${formatUsd(projection.crossedThresholdUsd ?? projection.nextThresholdUsd)}`,
    '',
    '読む場合は「はい」、やめる場合は「いいえ」と返信してください。',
    '範囲を絞る場合は、ページ範囲・章・知りたい観点を返信してください。',
  ].join('\n');
}

function buildSessionApprovalPrompt(
  pending: PendingSessionApproval,
  config: SessionCostGuardConfig,
): string {
  const yen = Math.round(pending.currentUsd * config.usdToJpy);
  return [
    'Cost Guard 確認',
    `この session の累計が $${formatUsd(pending.currentUsd)}（約${yen.toLocaleString('ja-JP')}円）です。`,
    `この session の対話を続けますか？`,
    `「はい」なら $${formatUsd(pending.nextThresholdUsd)} 到達時まで続行します。`,
    '「いいえ」なら次の発話を新しい session で開始します。',
  ].join('\n');
}

function parseApprovalDecision(text: string): 'yes' | 'no' | null {
  const normalised = text.trim().toLowerCase().replace(/[\s。、．.！!？?]+/g, '');
  if (!normalised) return null;
  if (
    normalised.startsWith('はい') ||
    normalised.startsWith('yes') ||
    normalised === 'y' ||
    normalised.startsWith('全文で進め') ||
    normalised.startsWith('全文で読') ||
    normalised.startsWith('続け') ||
    normalised.startsWith('続行')
  ) {
    return 'yes';
  }
  if (
    normalised.startsWith('いいえ') ||
    normalised.startsWith('no') ||
    normalised === 'n' ||
    normalised.startsWith('やめ') ||
    normalised.startsWith('止め') ||
    normalised.startsWith('停止') ||
    normalised.startsWith('終了')
  ) {
    return 'no';
  }
  return null;
}

function pricingForModel(
  model: string,
  config: SessionCostGuardConfig,
): typeof PRICING_USD_PER_MTOK[string] | null {
  const trimmed = model.trim();
  if (PRICING_USD_PER_MTOK[trimmed]) return PRICING_USD_PER_MTOK[trimmed];
  for (const [key, value] of Object.entries(PRICING_USD_PER_MTOK)) {
    if (trimmed.includes(key)) return value;
  }
  return PRICING_USD_PER_MTOK[config.fallbackModel] ?? null;
}

function cacheCreationTokens(usage: Record<string, unknown>): [number, number] {
  const nested = usage.cache_creation;
  if (nested && typeof nested === 'object') {
    const obj = nested as Record<string, unknown>;
    return [
      safeTokenCount(obj.ephemeral_5m_input_tokens) ?? 0,
      safeTokenCount(obj.ephemeral_1h_input_tokens) ?? 0,
    ];
  }
  return [safeTokenCount(usage.cache_creation_input_tokens) ?? 0, 0];
}

function safeTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function parseNumberList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  return sanitiseThresholds(
    raw
      .split(',')
      .map((part) => Number.parseFloat(part.trim()))
      .filter((n) => Number.isFinite(n)),
  );
}

function sanitiseThresholds(values: number[] | undefined): number[] | null {
  const out = [...new Set((values ?? []).filter((n) => Number.isFinite(n) && n > 0))]
    .sort((a, b) => a - b);
  return out.length > 0 ? out : null;
}

function positiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function formatUsd(value: number): string {
  return value.toFixed(Number.isInteger(value) ? 0 : 2);
}

function formatUsdNullable(value: number | null): string {
  if (value === null) return '不明';
  return `$${formatUsd(value)}`;
}

function formatTokenRange(low: number | null, high: number | null): string {
  if (low === null || high === null) return '不明';
  return `${low.toLocaleString('ja-JP')}-${high.toLocaleString('ja-JP')}`;
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
  KIND_EXTERNAL_API_CALL,
  PREFIX,
  COUNTER_TTL_SEC,
};
