/**
 * SCHEDULE_ACTION marker parser + executor — Cloud Run の
 * `_handle_schedule_action_marker` (`scripts/cma_gchat_bot.py` l.1153) +
 * `_exec_schedule_action` (l.1102) + `_strip_schedule_action_on_unresolved`
 * (l.1665) の TS port。
 *
 * MAKOTOくん が応答末尾に `SCHEDULE_ACTION:{"action": ..., "job_id": ...,
 * "cron": ..., "handler": ..., "payload": ..., "description": ...}`
 * マーカーを書くと、bot 側で全件 parse して順次実行する。Cloud Run
 * では `scheduled_job_manager.py` 経由で Cloud Scheduler を操作する
 * が、Cloudflare 側では Cloud Scheduler が無いので **実行層は呼出側
 * から callback で注入** (`ScheduleJobManager` interface)。
 *
 * 本 lib の責務:
 *   1. marker 文字列の regex parse (Python `_SCHEDULE_ACTION_MARKER_RE`
 *      と byte 等価: `SCHEDULE_ACTION:(\{[^\n]+\})`)
 *   2. JSON validation + skip_execution mode (= Issue #84: cap 系
 *      stop_reason で打ち切った時に副作用を skip)
 *   3. 実行 callback の呼び分け (action ごとに manager method を分岐)
 *
 * 実 scheduler 実装 (= Cloudflare Cron Triggers / Queue / DO 等) は
 * 本 lib では決めない。`ScheduleJobManager` 実装は別 lib (= Phase 2
 * 内 row #12 daily report と同じ scheduler 系で詰める)。
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — port mapping v1 §1 row #18)
 * Source: scripts/cma_gchat_bot.py l.1102-1191 (parse + exec + handler)
 *         scripts/cma_gchat_bot.py l.1665-1683 (strip on unresolved)
 */

/**
 * Python `_SCHEDULE_ACTION_MARKER_RE = re.compile(r'SCHEDULE_ACTION:(\{[^\n]+\})')`
 * と byte 等価。1 行に 1 marker、改行を跨いだ JSON は許容しない (= Python
 * 側の仕様、bot プロンプトも 1 行要求)。
 */
const MARKER_REGEX = /SCHEDULE_ACTION:(\{[^\n]+\})/g;

/**
 * SCHEDULE_ACTION dict の action 値。Python l.1107-1148 の if-chain 等価。
 */
export type ScheduleAction =
  | 'list'
  | 'create'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'run_once'
  | 'update';

export interface ScheduleActionData {
  action: ScheduleAction | string;
  job_id?: string;
  cron?: string;
  handler?: string;
  payload?: Record<string, unknown>;
  description?: string;
}

export interface ParsedScheduleAction {
  /** raw JSON 文字列 (= Python `m.group(1)`) */
  rawJson: string;
  /** parse 成功時の dict */
  data?: ScheduleActionData;
  /** parse 失敗時のエラーメッセージ (Python l.1186 と同形式) */
  parseError?: string;
}

/**
 * `ScheduleJobManager` — 実行層の interface。Cloud Run 側
 * `scheduled_job_manager.py` の主 method 群と等価。Cloudflare 用の
 * 実装は別 lib で提供する (= 本 lib は parse + dispatch のみ)。
 */
export interface ScheduleJob {
  job_id: string;
  cron: string;
  handler: string;
  payload?: Record<string, unknown>;
  description?: string;
  paused?: boolean;
}

export interface ScheduleJobManager {
  list_jobs(): Promise<ScheduleJob[]> | ScheduleJob[];
  format_job_list(jobs: ScheduleJob[]): string;
  get_job(job_id: string): Promise<ScheduleJob | null> | ScheduleJob | null;
  create_job(
    job_id: string,
    cron: string,
    handler: string,
    payload: Record<string, unknown>,
    options: { description?: string },
  ): Promise<void> | void;
  pause_job(job_id: string): Promise<void> | void;
  resume_job(job_id: string): Promise<void> | void;
  delete_job(job_id: string): Promise<void> | void;
  run_job_once(job_id: string): Promise<void> | void;
  update_job(
    job_id: string,
    patch: {
      cron?: string | undefined;
      payload?: Record<string, unknown> | undefined;
      description?: string | undefined;
      handler?: string | undefined;
    },
  ): Promise<void> | void;
}

export interface HandleScheduleActionResult {
  /**
   * 最初の marker 直前までの自由文 (Python l.1165 `prefix`)。
   * marker が無い場合は元の `final_text` をそのまま入れる。
   */
  prefix: string;
  /**
   * 各 marker 実行結果文字列 (Python `_exec_schedule_action` の戻り値)。
   * skip_execution=true の場合は空配列。
   */
  results: string[];
  /**
   * 連結済の bot 応答 (= prefix + "\n" + results.join("\n") の Python
   * 等価出力)。caller はこれをそのまま Chat に流せる。
   */
  combinedText: string;
  /** 検出 marker 件数 (0 = marker 無し)。 */
  markerCount: number;
}

/**
 * marker 全件を regex で抽出する純関数。実行はしない (= unit test 用
 * + dry-run / preview 用)。
 */
export function parseScheduleActionMarkers(
  text: string,
): ParsedScheduleAction[] {
  const out: ParsedScheduleAction[] = [];
  // exec ループ — `/g` flag なので毎回 lastIndex が進む。
  MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_REGEX.exec(text)) !== null) {
    const rawJson = m[1]!;
    let data: ScheduleActionData | undefined;
    let parseError: string | undefined;
    try {
      data = JSON.parse(rawJson) as ScheduleActionData;
      if (typeof data !== 'object' || data === null) {
        throw new TypeError('SCHEDULE_ACTION marker JSON must decode to an object');
      }
    } catch (exc) {
      parseError = (exc as Error).message;
    }
    out.push(parseError !== undefined ? { rawJson, parseError } : { rawJson, data });
  }
  return out;
}

/**
 * Python `_strip_schedule_action_on_unresolved` 等価。`has_unresolved=true`
 * のとき marker を全件除去して残り文字列を返す。空時 fallback 文言なし
 * (Python l.1673 と等価)。
 */
export function stripScheduleActionMarkers(text: string): string {
  return text.replace(MARKER_REGEX, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Python `_handle_schedule_action_marker` 等価 + 実行層 callback 注入。
 * marker を全件 parse して順次実行、結果を集約して返す。
 *
 * `skipExecution=true` の場合は副作用を実行せず、Python l.1167-1169 の
 * prefix-only 戻りに合わせて `combinedText = prefix` (results は空)。
 */
export async function handleScheduleActionMarker(
  text: string,
  manager: ScheduleJobManager,
  options: { skipExecution?: boolean } = {},
): Promise<HandleScheduleActionResult> {
  const matches = parseScheduleActionMarkers(text);
  if (matches.length === 0) {
    return {
      prefix: text,
      results: [],
      combinedText: text,
      markerCount: 0,
    };
  }
  // Python l.1165 — 最初の marker 直前を rstrip
  // (元 text に対する全文位置を再計算)。
  MARKER_REGEX.lastIndex = 0;
  const firstMatch = MARKER_REGEX.exec(text)!;
  const prefix = text.slice(0, firstMatch.index).replace(/\s+$/, '');

  if (options.skipExecution) {
    return {
      prefix,
      results: [],
      combinedText: prefix,
      markerCount: matches.length,
    };
  }

  const results: string[] = [];
  for (const m of matches) {
    if (m.parseError) {
      results.push(`❌ JSON parse error: ${m.parseError}`);
      continue;
    }
    results.push(await execScheduleAction(m.data!, manager));
  }

  const combinedText = prefix
    ? `${prefix}\n${results.join('\n')}`
    : results.join('\n');

  return { prefix, results, combinedText, markerCount: matches.length };
}

/**
 * 1 件の SCHEDULE_ACTION dict を実行して結果文字列を返す。Python
 * `_exec_schedule_action` (l.1102) の TS port。文言は byte 等価
 * (絵文字 + 構文を Cloud Run と揃える)。
 */
async function execScheduleAction(
  data: ScheduleActionData,
  manager: ScheduleJobManager,
): Promise<string> {
  const action = data.action ?? '';
  const jobId = data.job_id ?? '';
  try {
    if (action === 'list') {
      const jobs = await manager.list_jobs();
      return `✅ 定期実行ジョブ一覧:\n${manager.format_job_list(jobs)}`;
    }
    if (!jobId) {
      return `❌ スケジュール操作失敗: job_id が未指定 (action=${action})`;
    }
    if (action === 'create') {
      const cron = data.cron ?? '';
      const handler = data.handler ?? 'cma_session';
      const payload = data.payload ?? {};
      const description = data.description ?? '';
      if (!cron) return `❌ \`${jobId}\`: cron が未指定`;
      if (await manager.get_job(jobId)) {
        return `❌ \`${jobId}\`: 既に存在 (削除してから再作成 or update で更新)`;
      }
      await manager.create_job(jobId, cron, handler, payload, { description });
      return `✅ \`${jobId}\` 登録 (${cron}, ${description})`;
    }
    if (action === 'pause') {
      await manager.pause_job(jobId);
      return `✅ \`${jobId}\` 一時停止`;
    }
    if (action === 'resume') {
      await manager.resume_job(jobId);
      return `✅ \`${jobId}\` 再開`;
    }
    if (action === 'delete') {
      await manager.delete_job(jobId);
      return `✅ \`${jobId}\` 削除`;
    }
    if (action === 'run_once') {
      await manager.run_job_once(jobId);
      return `✅ \`${jobId}\` 即時実行`;
    }
    if (action === 'update') {
      const patch: {
        cron?: string;
        payload?: Record<string, unknown>;
        description?: string;
        handler?: string;
      } = {};
      if (data.cron !== undefined) patch.cron = data.cron;
      if (data.payload !== undefined) patch.payload = data.payload;
      if (data.description !== undefined) patch.description = data.description;
      if (data.handler !== undefined) patch.handler = data.handler;
      await manager.update_job(jobId, patch);
      const updated: string[] = [];
      if (patch.cron) updated.push(`cron=${patch.cron}`);
      if (patch.description) updated.push(`desc=${patch.description}`);
      if (patch.payload) updated.push('payload更新');
      if (patch.handler) updated.push(`handler=${patch.handler}`);
      return `✅ \`${jobId}\` 更新 (${updated.join(', ')})`;
    }
    return `❌ 不明なアクション: ${action}`;
  } catch (exc) {
    const errName = (exc as Error).name ?? 'Error';
    const errMsg = (exc as Error).message ?? String(exc);
    return `❌ \`${jobId || action}\`: ${errName}: ${errMsg}`;
  }
}
