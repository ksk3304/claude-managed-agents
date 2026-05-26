/**
 * Reactive cap recovery — Cloud Run の `_resolve_reactive_max_tool_calls` +
 * `_reactive_cap_recovery_enabled` (= scripts/cma_gchat_bot.py l.1392-1430)
 * + `run_cap_recovery` (= scripts/cma_lib.py l.3100) の TS port。
 *
 * reactive 経路 (= bot 経由) の `agent.tool_use` 呼出上限と、cap 到達後の
 * recovery turn (= もう 1 turn 回して memory 維持 + 部分テキストを完結
 * させる機構) のフラグ管理 + 実行 primitive を担う。
 *
 * Cloud Run 側との差:
 *   - Cloud Run は `_log_event` で WARN を構造化ログに吐く。TS では
 *     `console.warn(JSON.stringify(...))` で同等の構造化ログを出す。
 *   - Python は `ThreadPoolExecutor + future.result(timeout)` で wall
 *     timeout を bound する (= スレッド)。TS 側は `Promise.race` で
 *     同等の壁時計 bound を実現 (orphan promise は GC + Worker isolate
 *     終端でクリーンアップされる)。
 *   - Python の `tool_dispatch=None` 経路 = custom tool 無効化。TS 側は
 *     呼出側が「tool を呼ばれたら is_error で叩き返す」reject dispatcher
 *     を作って渡すことで同等の意味を実現する。本 lib は recovery 用の
 *     `createRejectingToolDispatcher()` を helper として export する。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #21)
 * Source: scripts/cma_gchat_bot.py l.1388-1430
 *         scripts/cma_lib.py l.3100-3183 (run_cap_recovery 共有関数)
 *         scripts/cma_lib.py l.83-103     (_RECOVERY_MAX_TOOL_CALLS /
 *           _RECOVERY_WALL_TIMEOUT_SEC / _RECOVERY_PROMPT)
 */

/**
 * reactive 経路の `agent.tool_use` 既定上限。Python `_REACTIVE_DEFAULT_
 * MAX_TOOL_CALLS = 40` と等価。env `CMA_REACTIVE_MAX_TOOL_CALLS` が未設定
 * か invalid のときに使われる。
 */
export const REACTIVE_DEFAULT_MAX_TOOL_CALLS = 40;

/**
 * env で許容する上限。Python `_REACTIVE_MAX_TOOL_CALLS_CEIL = 60` と等価。
 * これを超える値は WARN + default fallback。
 */
export const REACTIVE_MAX_TOOL_CALLS_CEIL = 60;

const ENV_MAX_TOOL_CALLS = 'CMA_REACTIVE_MAX_TOOL_CALLS';
const ENV_CAP_RECOVERY_ENABLED = 'CMA_REACTIVE_CAP_RECOVERY_ENABLED';

/** Cloud Run の `_log_event(level="WARN", message=...)` 構造化ログと等価。 */
export interface CapRecoveryLogger {
  warn(event: string, fields: Record<string, unknown>): void;
}

/** デフォルト logger — `console.warn` に JSON 1 行で出す。 */
export const defaultCapRecoveryLogger: CapRecoveryLogger = {
  warn(event, fields) {
    console.warn(
      JSON.stringify({ event, level: 'WARN', ...fields }),
    );
  },
};

/**
 * reactive 経路の `agent.tool_use` 上限を env から解決する。Python
 * `_resolve_reactive_max_tool_calls` (l.1392) の TS port。
 *
 *   - env `CMA_REACTIVE_MAX_TOOL_CALLS` 未設定 → default (40)
 *   - 整数 parse 失敗 → WARN + default
 *   - 範囲外 (1 ≤ v ≤ CEIL の範囲外) → WARN + default
 *   - 正常範囲 → その値
 */
export function resolveReactiveMaxToolCalls(
  envValue: string | undefined,
  logger: CapRecoveryLogger = defaultCapRecoveryLogger,
): number {
  const raw = (envValue ?? '').trim();
  if (raw === '') {
    return REACTIVE_DEFAULT_MAX_TOOL_CALLS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    logger.warn('reactive_config', {
      message: 'cma_reactive_max_tool_calls_invalid',
      reactive_max_tool_calls_raw: raw,
      fallback: REACTIVE_DEFAULT_MAX_TOOL_CALLS,
    });
    return REACTIVE_DEFAULT_MAX_TOOL_CALLS;
  }
  if (parsed < 1 || parsed > REACTIVE_MAX_TOOL_CALLS_CEIL) {
    logger.warn('reactive_config', {
      message: 'cma_reactive_max_tool_calls_out_of_range',
      reactive_max_tool_calls_raw: raw,
      fallback: REACTIVE_DEFAULT_MAX_TOOL_CALLS,
    });
    return REACTIVE_DEFAULT_MAX_TOOL_CALLS;
  }
  return parsed;
}

/**
 * reactive cap recovery turn の feature flag。Python
 * `_reactive_cap_recovery_enabled` (l.1420) の TS port。
 *
 * 既定有効。env が `"0"` / `"false"` / `"no"` (大小無視) の時のみ false。
 * scheduled 経路の recovery には影響しない (= reactive 専用フラグ)。
 */
export function isReactiveCapRecoveryEnabled(
  envValue: string | undefined,
): boolean {
  const v = (envValue ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * 両 env を一括解決する helper。caller は worker env を直接渡せる:
 *
 *   const config = resolveCapRecoveryConfig({
 *     CMA_REACTIVE_MAX_TOOL_CALLS: env.CMA_REACTIVE_MAX_TOOL_CALLS,
 *     CMA_REACTIVE_CAP_RECOVERY_ENABLED: env.CMA_REACTIVE_CAP_RECOVERY_ENABLED,
 *   });
 */
export interface CapRecoveryEnv {
  CMA_REACTIVE_MAX_TOOL_CALLS?: string;
  CMA_REACTIVE_CAP_RECOVERY_ENABLED?: string;
}

export interface CapRecoveryConfig {
  maxToolCalls: number;
  recoveryEnabled: boolean;
}

export function resolveCapRecoveryConfig(
  env: CapRecoveryEnv,
  logger: CapRecoveryLogger = defaultCapRecoveryLogger,
): CapRecoveryConfig {
  return {
    maxToolCalls: resolveReactiveMaxToolCalls(env[ENV_MAX_TOOL_CALLS], logger),
    recoveryEnabled: isReactiveCapRecoveryEnabled(
      env[ENV_CAP_RECOVERY_ENABLED],
    ),
  };
}

/**
 * cap stop reason 判定。Python `_CAP_STOP_REASONS` と等価。
 * `email-send-marker.ts:CAP_STOP_REASONS` と byte 等価だが、本 lib は
 * 独立した import path を提供する (= 利用側が cap recovery 文脈で参照
 * する時の意味的明確化)。
 */
export const CAP_STOP_REASONS_FOR_RECOVERY = [
  'tool_call_cap',
  'max_iter',
  'session_watchdog',
] as const;

export function isCapStopReason(stopReason: string): boolean {
  return (CAP_STOP_REASONS_FOR_RECOVERY as readonly string[]).includes(stopReason);
}

/**
 * recovery turn を回すべきか判定。
 *   - cap stop reason である AND recoveryEnabled=true → true
 *   - それ以外 → false
 *
 * 実 recovery turn (= もう 1 turn 回して memory 維持) の実装は
 * `runCapRecovery` (= cma_lib.py l.3100 の port) に委譲。本 lib では
 * interface 定義のみ提供し、実装は #5 reactive bot 統合で書く。
 */
export function shouldAttemptCapRecovery(
  stopReason: string,
  config: CapRecoveryConfig,
): boolean {
  return config.recoveryEnabled && isCapStopReason(stopReason);
}

// ============================================================================
// run_cap_recovery TS port (= cma_lib.py l.3100-3183)
// ============================================================================

/**
 * Python `_RECOVERY_MAX_TOOL_CALLS = 3` と byte 等価。recovery turn の
 * `agent.tool_use` 上限 (cap 到達後の追撃は「収集済み情報で本文を書く」
 * だけが目的でツール再探索は不要。0 不可のため最小 3、Python と同値)。
 */
export const RECOVERY_MAX_TOOL_CALLS = 3;

/**
 * Python `_RECOVERY_WALL_TIMEOUT_SEC = 150` と byte 等価 (ms 単位に換算)。
 * recovery turn の壁時計上限。150s = ツール無しで本文執筆に十分、reactive
 * の Pub/Sub ack deadline 360s の内側 (Issue #160 phase0-spike結果.md
 * アーム b1)。TS では Workers Queue consumer の 15 min budget の内側にも
 * 収まる (= 110s session stream timeout より長いが、recovery は通常 cap
 * 後の追撃なので OK)。
 */
export const RECOVERY_WALL_TIMEOUT_MS = 150_000;

/**
 * Python `_RECOVERY_PROMPT` (cma_lib.py l.95-103) と byte 等価。「出力
 * マーカー禁止・本文のみ」を明記 (recovery 中に EMAIL_SEND / CHAT_POST
 * 等のマーカーを吐かせない。呼出側 strip も多層防御で残すが prompt 段で
 * 抑止する)。
 *
 * **byte 等価維持注意**: 改行・読点・記号は Python 側と同一でなければ
 * ならない (両側 fixture で同 prompt を assert する parity test の対象)。
 */
export const RECOVERY_PROMPT =
  '【ツール使用が上限に達しました】これ以上ツール (bash / read / grep 等) は' +
  '使用できません。新たな調査・ファイル読み込みは一切行わず、ここまでで既に' +
  '収集・把握した情報だけを使って、最初に依頼された内容を *今すぐ完成形で* ' +
  '出力してください。情報が取得できなかった項目は「取得未完了」と明記して' +
  '構いません。ツールは呼ばず、本文テキストのみで回答してください。' +
  'EMAIL_SEND / CHAT_POST / SCHEDULE_ACTION 等の出力マーカーは一切付けず、' +
  'ユーザーに見せる本文だけを書いてください。';

/**
 * recovery turn の戻り envelope。Python `run_cap_recovery` の dict と
 * shape 互換 (snake_case → camelCase は別軸)。
 *
 * - `text`: 生成テキスト (`.trim()` 済、marker strip 等の後段処理は未適用)
 * - `stopReason`: recovery turn の terminal event (= `terminalEventType`
 *   ベース。session.ts の `'limit.custom_tool_calls'` / `'error.events_send'`
 *   / `'session.status_idle'` / `'session.status_terminated'` 等)
 * - `outcome`: `'recovered'` (非空) / `'empty'` (完了したが空) /
 *   `'timeout'` (wall timeout) / `'failed'` (例外)
 * - `toolNames`: recovery 中に観測した tool 名 list。非空なら呼出側で
 *   degraded 判定 (Python と同様、戻り値で確定 = callback flag 運用なし)
 * - `error`: outcome が `'timeout'` / `'failed'` の時のみ詳細文字列、
 *   それ以外は空文字 (`""`)
 */
export type CapRecoveryOutcome = 'recovered' | 'empty' | 'timeout' | 'failed';

export interface CapRecoveryResult {
  text: string;
  stopReason: string;
  outcome: CapRecoveryOutcome;
  toolNames: string[];
  error: string;
}

/**
 * 呼出側 (chat-event-handler 等) が recovery turn の event stream に対して
 * inject する「もう一度 user.message を送って drain する」executor。
 *
 * 本 lib は `session.ts` への hard 依存を避けるため、executor を引数として
 * 受け取る (= dependency injection)。実体は呼出側で
 * `sendAndStreamWithToolDispatch` を bind した closure を渡す:
 *
 *   const executor: CapRecoveryStreamExecutor = async ({
 *     sessionId, recoveryPrompt, maxToolCalls, toolDispatcher,
 *   }) => {
 *     const res = await sendAndStreamWithToolDispatch(client, {
 *       sessionId, userMessage: recoveryPrompt,
 *       toolDispatcher, maxToolCalls,
 *     });
 *     return {
 *       text: res.assistantText,
 *       stopReason: res.terminalEventType ?? '',
 *       toolNames: [],  // executor 側で observable なら埋める
 *     };
 *   };
 *
 * Python `send_to_session(..., tool_dispatch=None)` 経路と同等の意味
 * (= custom tool 無効化) を呼出側が保証する。本 lib では
 * `createRejectingToolDispatcher()` を helper として提供する。
 */
export interface CapRecoveryStreamExecutorInput {
  sessionId: string;
  recoveryPrompt: string;
  maxToolCalls: number;
  /**
   * recovery 中に custom tool が呼ばれた場合に確実に拒絶する dispatcher。
   * 呼出側は `createRejectingToolDispatcher(observed)` を渡し、observed
   * 配列に名前を push してもらうことで `toolNames` を埋める。
   */
  toolDispatcher: (toolName: string, input: unknown) => Promise<{
    ok: boolean;
    payload: unknown;
  }>;
}

export interface CapRecoveryStreamExecutorResult {
  text: string;
  stopReason: string;
}

export type CapRecoveryStreamExecutor = (
  input: CapRecoveryStreamExecutorInput,
) => Promise<CapRecoveryStreamExecutorResult>;

/**
 * recovery 中の custom tool を全て `is_error` で叩き返す dispatcher を
 * 生成する helper。Python 側 `tool_dispatch=None` (= custom tool 無効化)
 * と同じ意味を保証する。
 *
 * - 戻り値は `{ok: false, payload: {error: 'recovery_tool_disabled', ...}}`
 * - 呼ばれた tool 名は `observedToolNames` 配列に push される (呼出側が
 *   recovery 後に `toolNames` として参照する)
 * - 拒絶後も loop は継続する (= agent が他の応答方法を選ぶ余地を残す)
 */
export function createRejectingToolDispatcher(
  observedToolNames: string[],
): (toolName: string, input: unknown) => Promise<{
  ok: boolean;
  payload: unknown;
}> {
  return async (toolName, _input) => {
    observedToolNames.push(toolName);
    return {
      ok: false,
      payload: {
        error: 'recovery_tool_disabled',
        message:
          'ツール使用は recovery turn 中無効化されています。収集済み情報のみで応答してください。',
        tool: toolName,
      },
    };
  };
}

export interface RunCapRecoveryInput {
  sessionId: string;
  recoveryPrompt?: string;
  maxToolCalls?: number;
  wallTimeoutMs?: number;
  /**
   * 実 stream 実行 closure。caller が `sendAndStreamWithToolDispatch` を
   * bind したものを渡す (本 lib は `session.ts` に hard 依存しない)。
   */
  executor: CapRecoveryStreamExecutor;
}

/**
 * cap 到達後の recovery turn 実行 primitive。Python `run_cap_recovery`
 * (cma_lib.py l.3100) の TS port。
 *
 * 同一 session に「ツール禁止・収集済み情報で本文を書け」を `executor`
 * 経由で追撃し、生成テキストを返す。**投稿 / scrub / usage 記録 /
 * status 判定 / `_extract_final` / cap notice fallback は一切しない
 * (すべて呼出側責務)**。reactive (chat-event-handler) / scheduled
 * (cron-handler 将来) 双方の単一情報源。
 *
 * `executor` 内 timeout は本関数側で `Promise.race` で bound する
 * (Python の `ThreadPoolExecutor + future.result(timeout)` と同等の意味)。
 * orphan promise は GC + Worker isolate 終端でクリーンアップされる
 * (Python thread と同様、wall timeout 経過後の running worker は abort
 * 不可。本 lib は呼出側 handler を待たせない契約だけ守る)。
 */
export async function runCapRecovery(
  input: RunCapRecoveryInput,
): Promise<CapRecoveryResult> {
  const recoveryPrompt = input.recoveryPrompt ?? RECOVERY_PROMPT;
  const maxToolCalls = input.maxToolCalls ?? RECOVERY_MAX_TOOL_CALLS;
  const wallTimeoutMs = input.wallTimeoutMs ?? RECOVERY_WALL_TIMEOUT_MS;

  const observedToolNames: string[] = [];
  const toolDispatcher = createRejectingToolDispatcher(observedToolNames);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const execPromise = input.executor({
      sessionId: input.sessionId,
      recoveryPrompt,
      maxToolCalls,
      toolDispatcher,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`recovery wall timeout >${wallTimeoutMs}ms`));
      }, wallTimeoutMs);
    });

    const raw = await Promise.race([execPromise, timeoutPromise]);
    const text = (raw.text ?? '').trim();
    const stopReason = raw.stopReason ?? '';
    return {
      text,
      stopReason,
      outcome: text ? 'recovered' : 'empty',
      toolNames: observedToolNames.slice(),
      error: '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.startsWith('recovery wall timeout');
    return {
      text: '',
      stopReason: '',
      outcome: isTimeout ? 'timeout' : 'failed',
      toolNames: observedToolNames.slice(),
      error: isTimeout
        ? msg
        : `${err instanceof Error ? err.constructor.name : 'Error'}: ${msg}`,
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * recovery turn 実行 interface (= 旧 skeleton)。下位互換のため残置。
 * 新規呼出側は `runCapRecovery` を直接使うこと。
 *
 * @deprecated `runCapRecovery` を直接呼出側で wrap して使う方が依存が浅い。
 */
export interface CapRecoveryRunner {
  runRecovery(input: {
    sessionId: string;
    stopReason: string;
    partialText: string;
  }): Promise<{ finalText: string; recovered: boolean }>;
}
