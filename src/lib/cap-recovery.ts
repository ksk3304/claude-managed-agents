/**
 * Reactive cap recovery — Cloud Run の `_resolve_reactive_max_tool_calls` +
 * `_reactive_cap_recovery_enabled` (= scripts/cma_gchat_bot.py l.1392-1430)
 * の TS port。
 *
 * reactive 経路 (= bot 経由) の `agent.tool_use` 呼出上限と、cap 到達後の
 * recovery turn (= もう 1 turn 回して memory 維持 + 部分テキストを完結
 * させる機構) のフラグ管理を担う。
 *
 * Cloud Run 側との差:
 *   - Cloud Run は `_log_event` で WARN を構造化ログに吐く。TS では
 *     `console.warn(JSON.stringify(...))` で同等の構造化ログを出す。
 *   - `run_cap_recovery` 本体 (= cma_lib.py l.3100 の追加 turn 実行 logic)
 *     は #5 reactive bot 経路統合で実装する (本 lib では import 可能な
 *     skeleton interface だけ提供)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #21)
 * Source: scripts/cma_gchat_bot.py l.1388-1430
 *         scripts/cma_lib.py l.3100 (run_cap_recovery 共有関数、TS 側は
 *           interface stub のみ)
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

/**
 * recovery turn 実行 interface — 実体は #5 reactive bot 統合で実装する。
 * 本 lib では呼出側が型安全に dispatch できるよう signature stub のみ。
 *
 * Cloud Run 側 `run_cap_recovery(client, session_id, ...)` は memory store
 * への部分テキスト保存 + 追加 turn を 1 回回して final_text を組み立てる
 * 流れ。Cloudflare 側では session.ts の event stream 経由で実装する想定。
 */
export interface CapRecoveryRunner {
  runRecovery(input: {
    sessionId: string;
    stopReason: string;
    partialText: string;
  }): Promise<{ finalText: string; recovered: boolean }>;
}
