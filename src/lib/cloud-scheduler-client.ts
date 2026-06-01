/**
 * Cloud Scheduler REST API client + `ScheduleJobManager` implementation
 * for the Cloudflare Worker bridge.
 *
 * Cloud Run 側 `scripts/scheduled_job_manager.py` の TS port。bot
 * (Cloudflare Worker) からは CRUD だけ呼び、Cloud Scheduler 自体は GCP
 * project `cma-bot-mp-20260501` / region `asia-northeast1` に残置する。
 *
 * 設計責務:
 *   1. SA JWT 経由で `https://oauth2.googleapis.com/token` から
 *      `cloud-platform` scope の access_token を取得 (= `chat-api.ts`
 *      の `getChatAccessToken` を `cloud-platform` scope で再利用、
 *      token cache は scope key 別で `chat-api.ts` 側 module-level cache
 *      が自然に独立 entry を持つ)
 *   2. `cloudscheduler.googleapis.com/v1` の CRUD endpoint を fetch
 *   3. `ScheduleJob` ↔ Cloud Scheduler resource (Python l.93-114 の
 *      `_build_job_body` 等価) の mapping
 *   4. `format_job_list` (Python l.326-343) byte 等価出力 (= `_cron_to_human`
 *      l.237-307 も port、Cloud Run と同一文字列で Chat 投稿される)
 *
 * 認証:
 *   - 既存 `env.CHAT_SA_KEY_JSON` を流用 (= 同 SA に Cloud Scheduler
 *     operator (= `roles/cloudscheduler.admin` or `jobRunner`) 権限追加
 *     で対応、Day 4 ユーザー手作業)
 *   - scope: `https://www.googleapis.com/auth/cloud-platform`
 *   - token cache は `chat-api.ts:getChatAccessToken` の module-level
 *     cache を再利用 (= scope key 別 entry で正しく分離される設計)
 *
 * Failure isolation:
 *   - Cloud Scheduler API 呼出失敗 (= 401 / 404 / 500) → throw
 *     `CloudSchedulerError`、呼出側 `handleScheduleActionMarker` 内 try/catch
 *     で error message を集約して Chat 投稿 (Python l.1149-1150 と同等)
 *   - SA JWT 構築失敗 → `chat-api.ts` 側で throw、本 module も透過
 *     させる
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 2 — SCHEDULE_ACTION 実 dispatch)
 * Source: scripts/scheduled_job_manager.py (full port)
 * Doc: https://cloud.google.com/scheduler/docs/reference/rest
 */

import { assertBridgeEgressAllowed } from './egress-guard';
import { getChatAccessToken, type ChatApiDeps } from './chat-api';
import type {
  ScheduleJob,
  ScheduleJobManager,
} from './schedule-action-marker';

/** Cloud Scheduler API base. */
const API_BASE = 'https://cloudscheduler.googleapis.com/v1';

/** Scheduler ジョブが pubsubTarget で使うタイムゾーン (Cloud Run 側 `_TIMEZONE` 等価)。 */
const DEFAULT_TIMEZONE = 'Asia/Tokyo';

/**
 * Cloud Platform 全体に届く scope。Cloud Scheduler operator 権限を
 * 持つ SA で `jobs.list` / `jobs.create` / `jobs.patch` / `jobs.pause`
 * / `jobs.resume` / `jobs.delete` / `jobs.run` を叩く。
 */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Python `_TIMEZONE` と byte 等価 (= "Asia/Tokyo")。 */
export const SCHEDULER_TIMEZONE = DEFAULT_TIMEZONE;

/** Cloud Run 側 `_PUBSUB_TOPIC_BASE` (= "cma-scheduled-jobs") と同じ既存 topic。 */
const DEFAULT_SCHEDULER_TOPIC = 'cma-scheduled-jobs';

/** `attemptDeadline` 秒数 (Python l.121 default 120s と byte 等価)。 */
const PUBLISH_ATTEMPT_DEADLINE_SEC = 120;

export interface CloudSchedulerDeps {
  /** Worker secret `CHAT_SA_KEY_JSON` (chat-api と同 SA を流用)。 */
  saKeyJson: string;
  /** GCP project ID (env `GCP_SCHEDULER_PROJECT`)。 */
  project: string;
  /** Cloud Scheduler ロケーション (env `GCP_SCHEDULER_LOCATION`)。 */
  location: string;
  /**
   * Scheduler job が publish する Pub/Sub topic。既定は既存本番と同じ
   * 単一 topic `cma-scheduled-jobs`。handler 分岐は attributes.handler で行う。
   */
  schedulerTopicName?: string;
  /**
   * Legacy override: handler 名 → topic 名 の組み立て prefix。指定時のみ
   * `<prefix><handler>` の複数 topic モデルを使う。
   */
  handlerTopicPrefix?: string;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
}

export class CloudSchedulerError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly action: string;
  constructor(message: string, status: number, responseBody: string, action: string) {
    super(message);
    this.name = 'CloudSchedulerError';
    this.status = status;
    this.responseBody = responseBody;
    this.action = action;
  }
}

interface CloudSchedulerJobResource {
  name?: string;
  schedule?: string;
  timeZone?: string;
  state?: 'ENABLED' | 'PAUSED' | 'UPDATE_FAILED' | 'STATE_UNSPECIFIED' | string;
  description?: string;
  pubsubTarget?: {
    topicName?: string;
    data?: string;
    attributes?: Record<string, string>;
  };
}

interface ListJobsResponse {
  jobs?: CloudSchedulerJobResource[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------

/**
 * `ScheduleJobManager` interface 実装を返す。lib として独立、
 * `chat-event-handler.ts` 以外からも呼べる (= 将来の管理 CLI / 別経路統合
 * に備える)。
 */
export function createCloudSchedulerManager(
  deps: CloudSchedulerDeps,
): ScheduleJobManager {
  const topicConfig =
    deps.handlerTopicPrefix !== undefined
      ? { mode: 'prefix' as const, prefix: deps.handlerTopicPrefix }
      : { mode: 'single' as const, topicName: deps.schedulerTopicName ?? DEFAULT_SCHEDULER_TOPIC };

  return {
    async list_jobs(): Promise<ScheduleJob[]> {
      const resources = await listJobsRaw(deps);
      return resources.map(resourceToScheduleJob);
    },
    format_job_list(jobs: ScheduleJob[]): string {
      return formatJobList(jobs);
    },
    async get_job(jobId: string): Promise<ScheduleJob | null> {
      const res = await getJobRaw(deps, jobId);
      return res ? resourceToScheduleJob(res) : null;
    },
    async create_job(
      jobId: string,
      cron: string,
      handler: string,
      payload: Record<string, unknown>,
      options: { description?: string },
    ): Promise<void> {
      await createJobRaw(deps, {
        jobId,
        cron,
        handler,
        payload,
        description: options.description ?? '',
        topicConfig,
      });
    },
    async pause_job(jobId: string): Promise<void> {
      await pauseJobRaw(deps, jobId);
    },
    async resume_job(jobId: string): Promise<void> {
      await resumeJobRaw(deps, jobId);
    },
    async delete_job(jobId: string): Promise<void> {
      await deleteJobRaw(deps, jobId);
    },
    async run_job_once(jobId: string): Promise<void> {
      await runJobOnceRaw(deps, jobId);
    },
    async update_job(
      jobId: string,
      patch: {
        cron?: string | undefined;
        payload?: Record<string, unknown> | undefined;
        description?: string | undefined;
        handler?: string | undefined;
      },
    ): Promise<void> {
      await updateJobRaw(deps, jobId, patch, topicConfig);
    },
  };
}

// ---------------------------------------------------------------------------
// REST API helpers
// ---------------------------------------------------------------------------

function chatDeps(deps: CloudSchedulerDeps): ChatApiDeps {
  const out: ChatApiDeps = { saKeyJson: deps.saKeyJson };
  if (deps.fetchImpl) out.fetchImpl = deps.fetchImpl;
  return out;
}

function parentPath(deps: CloudSchedulerDeps): string {
  return `projects/${deps.project}/locations/${deps.location}`;
}

function jobName(deps: CloudSchedulerDeps, jobId: string): string {
  return `${parentPath(deps)}/jobs/${jobId}`;
}

type SchedulerTopicConfig =
  | { mode: 'single'; topicName: string }
  | { mode: 'prefix'; prefix: string };

function topicName(
  deps: CloudSchedulerDeps,
  handler: string,
  topicConfig: SchedulerTopicConfig,
): string {
  const name =
    topicConfig.mode === 'prefix'
      ? `${topicConfig.prefix}${handler}`
      : topicConfig.topicName;
  return `projects/${deps.project}/topics/${name}`;
}

async function authedFetch(
  deps: CloudSchedulerDeps,
  url: string,
  init: RequestInit,
  action: string,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getChatAccessToken(chatDeps(deps), [CLOUD_PLATFORM_SCOPE]);
  assertBridgeEgressAllowed(url, `scheduler-client:${action}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const mergedHeaders = { ...headers, ...(init.headers as Record<string, string> | undefined) };
  return fetchImpl(url, { ...init, headers: mergedHeaders });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

async function ensureOk(
  response: Response,
  action: string,
): Promise<void> {
  if (response.ok) return;
  const body = await safeReadText(response);
  throw new CloudSchedulerError(
    `Cloud Scheduler ${action} failed status=${response.status} body=${body.slice(0, 300)}`,
    response.status,
    body,
    action,
  );
}

// list ----------------------------------------------------------------------

async function listJobsRaw(deps: CloudSchedulerDeps): Promise<CloudSchedulerJobResource[]> {
  const out: CloudSchedulerJobResource[] = [];
  let pageToken: string | undefined;
  let page = 0;
  while (true) {
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    const qs = params.toString();
    const url = `${API_BASE}/${parentPath(deps)}/jobs${qs ? `?${qs}` : ''}`;
    const response = await authedFetch(deps, url, { method: 'GET' }, 'list_jobs');
    await ensureOk(response, 'list_jobs');
    const data = (await response.json()) as ListJobsResponse;
    if (data.jobs) out.push(...data.jobs);
    page += 1;
    console.log(
      `[scheduler-client] list_jobs page=${page} count=${data.jobs?.length ?? 0} hasNext=${data.nextPageToken ? '1' : '0'}`,
    );
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

// get -----------------------------------------------------------------------

async function getJobRaw(
  deps: CloudSchedulerDeps,
  jobId: string,
): Promise<CloudSchedulerJobResource | null> {
  const url = `${API_BASE}/${jobName(deps, jobId)}`;
  const response = await authedFetch(deps, url, { method: 'GET' }, 'get_job');
  if (response.status === 404) {
    console.log(`[scheduler-client] get_job not_found job_id=${jobId}`);
    return null;
  }
  await ensureOk(response, 'get_job');
  const json = (await response.json()) as CloudSchedulerJobResource;
  console.log(`[scheduler-client] get_job ok job_id=${jobId} state=${json.state ?? '?'}`);
  return json;
}

// create --------------------------------------------------------------------

interface CreateJobInput {
  jobId: string;
  cron: string;
  handler: string;
  payload: Record<string, unknown>;
  description: string;
  topicConfig: SchedulerTopicConfig;
}

async function createJobRaw(
  deps: CloudSchedulerDeps,
  input: CreateJobInput,
): Promise<CloudSchedulerJobResource> {
  const url = `${API_BASE}/${parentPath(deps)}/jobs`;
  const body = buildJobBody(deps, input);
  const response = await authedFetch(
    deps,
    url,
    { method: 'POST', body: JSON.stringify(body) },
    'create_job',
  );
  await ensureOk(response, 'create_job');
  const json = (await response.json()) as CloudSchedulerJobResource;
  console.log(`[scheduler-client] create_job ok job_id=${input.jobId} cron=${input.cron}`);
  return json;
}

function buildJobBody(
  deps: CloudSchedulerDeps,
  input: CreateJobInput,
): Record<string, unknown> {
  // Python l.93-114 `_build_job_body` 等価。
  const dataB64 = base64EncodeUtf8(JSON.stringify(input.payload));
  return {
    name: jobName(deps, input.jobId),
    description: input.description,
    schedule: input.cron,
    timeZone: DEFAULT_TIMEZONE,
    pubsubTarget: {
      topicName: topicName(deps, input.handler, input.topicConfig),
      data: dataB64,
      attributes: {
        handler: input.handler,
        job_id: input.jobId,
        managed_by: 'cma-scheduled',
      },
    },
    attemptDeadline: `${PUBLISH_ATTEMPT_DEADLINE_SEC}s`,
  };
}

// pause / resume / delete / run --------------------------------------------

async function pauseJobRaw(deps: CloudSchedulerDeps, jobId: string): Promise<void> {
  const url = `${API_BASE}/${jobName(deps, jobId)}:pause`;
  const response = await authedFetch(
    deps,
    url,
    { method: 'POST', body: JSON.stringify({}) },
    'pause_job',
  );
  await ensureOk(response, 'pause_job');
  console.log(`[scheduler-client] pause_job ok job_id=${jobId}`);
}

async function resumeJobRaw(deps: CloudSchedulerDeps, jobId: string): Promise<void> {
  const url = `${API_BASE}/${jobName(deps, jobId)}:resume`;
  const response = await authedFetch(
    deps,
    url,
    { method: 'POST', body: JSON.stringify({}) },
    'resume_job',
  );
  await ensureOk(response, 'resume_job');
  console.log(`[scheduler-client] resume_job ok job_id=${jobId}`);
}

async function deleteJobRaw(deps: CloudSchedulerDeps, jobId: string): Promise<void> {
  const url = `${API_BASE}/${jobName(deps, jobId)}`;
  const response = await authedFetch(deps, url, { method: 'DELETE' }, 'delete_job');
  await ensureOk(response, 'delete_job');
  console.log(`[scheduler-client] delete_job ok job_id=${jobId}`);
}

async function runJobOnceRaw(deps: CloudSchedulerDeps, jobId: string): Promise<void> {
  const url = `${API_BASE}/${jobName(deps, jobId)}:run`;
  const response = await authedFetch(
    deps,
    url,
    { method: 'POST', body: JSON.stringify({}) },
    'run_job_once',
  );
  await ensureOk(response, 'run_job_once');
  console.log(`[scheduler-client] run_job_once ok job_id=${jobId}`);
}

// update --------------------------------------------------------------------

async function updateJobRaw(
  deps: CloudSchedulerDeps,
  jobId: string,
  patch: {
    cron?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    description?: string | undefined;
    handler?: string | undefined;
  },
  topicConfig: SchedulerTopicConfig,
): Promise<void> {
  // Python l.133-206 `update_job` 等価。
  const existing = await getJobRaw(deps, jobId);
  if (!existing) {
    throw new CloudSchedulerError(
      `ジョブ \`${jobId}\` が見つかりません`,
      404,
      '',
      'update_job',
    );
  }

  const updateMask: string[] = [];
  const body: Record<string, unknown> = {
    name: jobName(deps, jobId),
  };

  if (patch.cron !== undefined) {
    body.schedule = patch.cron;
    updateMask.push('schedule');
  }
  // description が明示指定されてなくて cron だけ変わった場合は、
  // description を自動再生成 (Python l.161 `auto_desc_needed` 等価)。
  const autoDescNeeded = patch.description === undefined && patch.cron !== undefined;
  if (patch.description !== undefined) {
    body.description = patch.description;
    updateMask.push('description');
  }

  if (patch.payload !== undefined || patch.handler !== undefined) {
    const curTarget = existing.pubsubTarget ?? {};
    const curHandler =
      patch.handler ?? curTarget.attributes?.handler ?? 'cma_session';
    let dataB64: string;
    if (patch.payload !== undefined) {
      dataB64 = base64EncodeUtf8(JSON.stringify(patch.payload));
    } else {
      dataB64 = curTarget.data ?? '';
    }
    body.pubsubTarget = {
      topicName:
        // Python l.176 と同等: 既存 topicName を保持しつつ、無ければ default
        // で組み立て直す。
        curTarget.topicName ?? topicName(deps, curHandler, topicConfig),
      data: dataB64,
      attributes: {
        handler: curHandler,
        job_id: jobId,
        managed_by: 'cma-scheduled',
      },
    };
    updateMask.push('pubsubTarget');
  }

  if (autoDescNeeded) {
    const curTarget = existing.pubsubTarget ?? {};
    const curHandler =
      patch.handler ?? curTarget.attributes?.handler ?? 'cma_session';
    let curPayload: Record<string, unknown> = {};
    if (patch.payload !== undefined) {
      curPayload = patch.payload;
    } else if (curTarget.data) {
      try {
        curPayload = JSON.parse(base64DecodeUtf8(curTarget.data)) as Record<string, unknown>;
      } catch {
        curPayload = {};
      }
    }
    body.description = makeDefaultDescription(patch.cron!, curHandler, curPayload);
    updateMask.push('description');
  }

  if (updateMask.length === 0) {
    throw new CloudSchedulerError(
      'update_job: 更新フィールドが指定されていません',
      400,
      '',
      'update_job',
    );
  }

  const params = new URLSearchParams({ updateMask: updateMask.join(',') });
  const url = `${API_BASE}/${jobName(deps, jobId)}?${params.toString()}`;
  const response = await authedFetch(
    deps,
    url,
    { method: 'PATCH', body: JSON.stringify(body) },
    'update_job',
  );
  await ensureOk(response, 'update_job');
  console.log(
    `[scheduler-client] update_job ok job_id=${jobId} mask=${updateMask.join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// resource ↔ ScheduleJob mapping
// ---------------------------------------------------------------------------

function resourceToScheduleJob(res: CloudSchedulerJobResource): ScheduleJob {
  const name = res.name ?? '';
  const jobId = name.split('/').slice(-1)[0] ?? '';
  const cron = res.schedule ?? '';
  const handler = res.pubsubTarget?.attributes?.handler ?? '';
  const description = res.description ?? '';
  const paused = res.state === 'PAUSED';
  let payload: Record<string, unknown> | undefined;
  if (res.pubsubTarget?.data) {
    try {
      payload = JSON.parse(base64DecodeUtf8(res.pubsubTarget.data)) as Record<string, unknown>;
    } catch {
      payload = undefined;
    }
  }
  const out: ScheduleJob = {
    job_id: jobId,
    cron,
    handler,
  };
  if (payload !== undefined) out.payload = payload;
  if (description) out.description = description;
  if (paused) out.paused = true;
  return out;
}

// ---------------------------------------------------------------------------
// format_job_list — Python l.326-343 byte 等価
// ---------------------------------------------------------------------------

/**
 * Python `format_job_list` (scheduled_job_manager.py l.326-343) と
 * **byte 等価** な Chat 投稿用文字列を返す。Cloud Run と同一フォーマット
 * で MAKOTOくん が一覧表示するため、絵文字 / 改行 / `cron:` のラベル
 * 順をすべて Python 側に揃える。
 *
 * Byte 等価の確認手順 (= Day 3 検証):
 *   1. Python: `python3 -c "import scheduled_job_manager as s; print(s.format_job_list([...]))"`
 *   2. TS: `console.log(formatJobList([...]))`
 *   3. 同じ ScheduleJob[] (Python は dict、TS は ScheduleJob) を与えて
 *      stdout を `diff -u` で突合。差分ゼロを合格判定とする。
 */
export function formatJobList(jobs: ScheduleJob[]): string {
  if (jobs.length === 0) return '定期実行ジョブなし';
  const lines: string[] = [];
  for (const j of jobs) {
    const name = j.job_id;
    const schedule = j.cron || '?';
    const desc = j.description ?? '';
    // Python l.336 — state ラベルは ENABLED / PAUSED の 2 値だけ正規。
    const stateLabel = j.paused ? '⏸停止中' : '▶稼働中';
    const humanTime = cronToHuman(schedule);
    let line = `・\`${name}\` [${stateLabel}]\n  時刻: ${humanTime} (cron: \`${schedule}\`)`;
    if (desc) line += `\n  説明: ${desc}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Python `_cron_to_human` (l.237-307) の byte 等価 port。
 *
 * 例:
 *   '40 10 * * *'    → '毎日 10:40'
 *   '0 15-17 * * *'  → '毎日 15:00, 16:00, 17:00 (1時間ごと)'
 *   '0 17,18 * * *'  → '毎日 17:00, 18:00'
 *   '0 9 * * 1'      → '毎週月曜 9:00'
 *   '0 * * * *'      → '毎時 00分 (1日24回)'
 */
export function cronToHuman(cron: string): string {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, dom, _month, dow] = parts as [string, string, string, string, string];
    void _month;

    const dowNames: Record<string, string> = {
      '0': '日', '1': '月', '2': '火', '3': '水',
      '4': '木', '5': '金', '6': '土', '7': '日',
    };
    let whenDay = '';
    if (dow !== '*' && dom === '*') {
      if (dow in dowNames) {
        whenDay = `毎週${dowNames[dow]}曜 `;
      } else if (dow.includes(',')) {
        const names = dow.split(',').map((d) => dowNames[d] ?? d);
        whenDay = `毎週${names.join(',')}曜 `;
      } else {
        whenDay = `曜日=${dow} `;
      }
    } else if (dow === '*' && dom === '*') {
      whenDay = '毎日 ';
    } else if (dom !== '*') {
      whenDay = `毎月${dom}日 `;
    }

    const expandField = (field: string, maxVal: number): number[] | null => {
      try {
        if (field === '*') {
          const out: number[] = [];
          for (let i = 0; i <= maxVal; i++) out.push(i);
          return out;
        }
        const vals = new Set<number>();
        for (const token of field.split(',')) {
          if (token.includes('-')) {
            const segs = token.split('-');
            const s = Number.parseInt(segs[0] ?? '', 10);
            const e = Number.parseInt(segs[1] ?? '', 10);
            if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
            for (let i = s; i <= e; i++) vals.add(i);
          } else {
            const v = Number.parseInt(token, 10);
            if (!Number.isFinite(v)) return null;
            vals.add(v);
          }
        }
        return Array.from(vals).sort((a, b) => a - b);
      } catch {
        return null;
      }
    };

    const minutes = expandField(minute, 59);
    const hours = expandField(hour, 23);
    if (minutes === null || hours === null) return cron;

    const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

    // 毎時 (hour == "*")
    if (hour === '*') {
      const prefix = whenDay === '毎日 ' ? '' : whenDay;
      if (minutes.length === 1) {
        return `${prefix}毎時 ${pad2(minutes[0]!)}分 (1日24回)`.trim();
      }
      const ms = minutes.map((m) => `${pad2(m)}分`).join(',');
      return `${prefix}毎時 ${ms}`.trim();
    }

    const times: string[] = [];
    for (const h of hours) {
      for (const m of minutes) {
        times.push(`${pad2(h)}:${pad2(m)}`);
      }
    }
    const timesStr = times.join(', ');

    let suffix = '';
    if (hours.length >= 3 && minutes.length === 1) {
      let isContiguous = true;
      for (let i = 0; i < hours.length; i++) {
        if (hours[i] !== hours[0]! + i) {
          isContiguous = false;
          break;
        }
      }
      if (isContiguous) suffix = ' (1時間ごと)';
    }

    return `${whenDay}${timesStr}${suffix}`.trim();
  } catch {
    return cron;
  }
}

/** Python `_make_default_description` (l.310-323) の byte 等価 port。 */
function makeDefaultDescription(
  cron: string,
  _handler: string,
  payload: Record<string, unknown>,
): string {
  void _handler;
  const human = cronToHuman(cron);
  let shortPrompt = '';
  if (payload && typeof payload === 'object') {
    const candidate =
      (typeof payload.prompt === 'string' ? payload.prompt : '') ||
      (typeof payload.subject === 'string' ? payload.subject : '');
    if (candidate.trim()) {
      shortPrompt = candidate.trim().replace(/\n/g, ' ').slice(0, 40);
    }
  }
  if (shortPrompt) return `${human} | ${shortPrompt}`;
  return human;
}

// ---------------------------------------------------------------------------
// base64 (UTF-8) helpers
// ---------------------------------------------------------------------------

function base64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64DecodeUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// test-only helpers
// ---------------------------------------------------------------------------

/**
 * `chat-api.ts` の module-level token cache を test 側で reset する用に
 * 再 export する。本 client は独自 cache を持たず chat-api 側 cache を
 * 再利用する設計のため、scheduler-client.test.ts も同 reset を使う。
 */
export { _resetChatTokenCacheForTests as _resetSchedulerClientCacheForTests } from './chat-api';

// Keep the default topic name referenced in module scope for drift checks.
void DEFAULT_SCHEDULER_TOPIC;
