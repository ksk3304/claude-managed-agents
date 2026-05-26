/**
 * Unit tests for `src/lib/cloud-scheduler-client.ts` — Cloud Scheduler
 * REST API client + `ScheduleJobManager` 実装。
 *
 * Covers (per task brief §test 設計):
 *   1. list_jobs: 2 job 返却 → ScheduleJob[] に変換
 *   2. list_jobs: pagination (`pageToken` 経由で 2 page、合算)
 *   3. get_job: 200 → ScheduleJob 単体
 *   4. get_job: 404 → null
 *   5. create_job: 正常 → POST body 検証 (base64 payload + topicName)
 *   6. pause_job / resume_job / delete_job / run_job_once: HTTP method 検証
 *   7. update_job: PATCH + updateMask 構築検証
 *   8. format_job_list: 純文字列フォーマット (Python l.326-343 byte 等価)
 *   9. token cache hit: 2 回目呼出は OAuth fetch しない
 *   10. SA JWT 構築失敗 (= 無効 PEM) → 適切な error
 *
 * RSA-2048 PKCS#8 private key (= throwaway fixture、`tests/chat-api.test.ts`
 * と同パターン)。Google には登録されておらず権限ゼロ。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCloudSchedulerManager,
  formatJobList,
  cronToHuman,
  CloudSchedulerError,
  _resetSchedulerClientCacheForTests,
} from '../src/lib/cloud-scheduler-client';
import { makeFetchMock } from './makoto-helpers';

/** UTF-8 -> base64 (test helper; mirrors `cloud-scheduler-client.ts` 内部実装). */
function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDMg3c8BYnUyuKy
/sE+hpSWDkzGpCSp4jkU7PEzl7z0ik36HN8m8wAv7OAjepJzMbi+hIOI+KYS7u8u
kKzH9R6qat3XtumMJJ/7C4azj9vvqlt0+hpfm/udtmqSvXq4szThcE5AlbD4sU1O
Up7qlgnaUsflxlyJ4Y+/ZKacFkNTJqYoxfM7rMwxgBc5zqrCCZp76Pypj+JIQ4O3
ZIewxBMVuyd5LDxrsNamXl7ENTga+1bBFQxdE6Zum6/oTLomhx94lwcgmTJX2GLx
q3HpxEpAaM29Og4sekRzYn/LYShN89mlwMai1kKtUwUZZnIDO0IW05rhtkxxUMsp
l9mAbJZvAgMBAAECggEABqKODL5CDkt8XVt5TRw0PkYKfmtQd5gYsZgaUmOUd5T0
TXszgvthQMZjlmMUoae16BOhtm2ytzlVoy7oaOuH6il7ajmYWO0BqU7JBcXscb/j
v02Z63FcRKECOVTr+7zWQcLqyjRqptB09jSLmVRZNeJEcyzwHAnbjjvat+rbYxtc
1juUqCPR568edUDfkMuZDBzJ3fRUhlYZDRwckeNpDiu83a6Gbyk8/lnn2HjUccvG
zcs2tOQTbVjZQB+7aeKqlvXR3nItIH03SFFR94M1nvsmmBlgoaDxIDsFrZQDion8
ad8SC6PFGHR1ZACc2iLD2IKoRvKUEnQsobtTxXSKqQKBgQDsbCD+g7kgP0ZhMStB
tYkhZBtLOP0Yxf6xkEqbWF7dypjn2aiSo/pFZkzvxyYDDY9vOlERAgxlIQQeDvVL
zmAiRqKH/P0dTTlQpfBa7D2UMXGLc3tEsDAnh6wr0Q8dAK8eVFPKLvmXKOdzo96s
3uI2hQkSchVbAyGxzJpUAxiBqwKBgQDdcuhe4AM45qn1FHIv/mtNFafv9aqwh4QC
ez46IBjzs06Tipbju0dkoV2Tl/XWH7hcLRBBwSHA5ysirCsni6ahfkoG8f+WDpn+
b/i/9ZtIr5YY1uifj4JMXNlHpgcRLuM8Qyjx0d7YU//yZmIgLCwET+sjtObSh/4i
EU9oKV7CTQKBgHBY5cjsgYGAcAppmhusj5CtiIbTevpVxDVO0xVFBjexOb4bYY7l
m111QqRC555VyE5b0QAbEBbSfKloBErUtDw1grDKmOFevBjF8hTS5GRSpplU9EPs
0cVHJJrhyqPGmnD4M6UFc5fQWURLn9pYQ/kSeQAp9Fn+f/mEt+WqXu/nAoGANPxm
jzTocHf4mJSA0ez9PZ995FOSuNRkCLf2ZrABaGYx2emiOvE3nuNhYYxNnSNP2HZL
2n/clKx7TLuHQ9oNT7zI96p1rjDmNdQS39NjiVvB/UWGuY777UuWDaezLzBZ3LRx
GpNNz9MhfZ1zwyDuk0WQDKYfSKaTbxFXP6QOcU0CgYBDS4hD1GHV+zMoJ/syRbeY
nm5ZxWUfP2OnCKT+sj+54DLHS53KwbquJRSNJBB4t/6IODAoStHfPpTLt18IfeQo
cmhs1W5d46A9bnEMLf/uZ/thauX8b771QGYLTDQMkgTlfTLsbnKcb4/XQ4iR4n/A
jFFa+31v/gSYzRUQMeyhUg==
-----END PRIVATE KEY-----`;

function fixtureSaKeyJson(): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cma-bot-mp-20260501',
    private_key_id: 'fixture-kid',
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: 'cma-chat-bot@cma-bot-mp-20260501.iam.gserviceaccount.com',
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(access_token = 'test-token', expires_in = 3600): Response {
  return jsonResponse(200, { access_token, expires_in, token_type: 'Bearer' });
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCHEDULER_BASE = 'https://cloudscheduler.googleapis.com/v1';
const PARENT = 'projects/test-proj/locations/asia-northeast1';

function makeDeps(fetchImpl: typeof fetch) {
  return {
    saKeyJson: fixtureSaKeyJson(),
    project: 'test-proj',
    location: 'asia-northeast1',
    handlerTopicPrefix: 'cma-scheduler-',
    fetchImpl,
  };
}

beforeEach(() => {
  _resetSchedulerClientCacheForTests();
});

// ---------------------------------------------------------------------------
// list_jobs
// ---------------------------------------------------------------------------

describe('list_jobs', () => {
  it('returns 2 jobs mapped to ScheduleJob[] from a single page', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs`);
      return jsonResponse(200, {
        jobs: [
          {
            name: `${PARENT}/jobs/daily-report`,
            schedule: '0 10 * * *',
            timeZone: 'Asia/Tokyo',
            state: 'ENABLED',
            description: '毎日 10:00 デイリーレポート',
            pubsubTarget: {
              topicName: 'projects/test-proj/topics/cma-scheduler-cma_session',
              data: b64Utf8(JSON.stringify({ prompt: 'デイリーレポート作成' })),
              attributes: { handler: 'cma_session', job_id: 'daily-report' },
            },
          },
          {
            name: `${PARENT}/jobs/weekly-review`,
            schedule: '0 9 * * 1',
            state: 'PAUSED',
            pubsubTarget: {
              attributes: { handler: 'cma_session' },
            },
          },
        ],
      });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    const jobs = await mgr.list_jobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      job_id: 'daily-report',
      cron: '0 10 * * *',
      handler: 'cma_session',
      description: '毎日 10:00 デイリーレポート',
      payload: { prompt: 'デイリーレポート作成' },
    });
    expect(jobs[0]!.paused).toBeUndefined();
    expect(jobs[1]).toMatchObject({
      job_id: 'weekly-review',
      cron: '0 9 * * 1',
      handler: 'cma_session',
      paused: true,
    });
  });

  it('paginates via nextPageToken and concatenates jobs across pages', async () => {
    let call = 0;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      call += 1;
      if (call === 1) {
        expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs`);
        return jsonResponse(200, {
          jobs: [
            {
              name: `${PARENT}/jobs/a`,
              schedule: '* * * * *',
              state: 'ENABLED',
            },
          ],
          nextPageToken: 'PAGE2',
        });
      }
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs?pageToken=PAGE2`);
      return jsonResponse(200, {
        jobs: [
          {
            name: `${PARENT}/jobs/b`,
            schedule: '0 0 * * *',
            state: 'ENABLED',
          },
        ],
      });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    const jobs = await mgr.list_jobs();
    expect(jobs.map((j) => j.job_id)).toEqual(['a', 'b']);
  });

  it('returns empty array when API returns no jobs field', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    expect(await mgr.list_jobs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// get_job
// ---------------------------------------------------------------------------

describe('get_job', () => {
  it('returns a single ScheduleJob on 200', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs/daily-x`);
      return jsonResponse(200, {
        name: `${PARENT}/jobs/daily-x`,
        schedule: '0 10 * * *',
        state: 'ENABLED',
        description: 'デイリー X',
        pubsubTarget: {
          attributes: { handler: 'cma_session' },
        },
      });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    const job = await mgr.get_job('daily-x');
    expect(job).not.toBeNull();
    expect(job!.job_id).toBe('daily-x');
    expect(job!.cron).toBe('0 10 * * *');
    expect(job!.handler).toBe('cma_session');
    expect(job!.description).toBe('デイリー X');
  });

  it('returns null on 404', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return new Response('NotFound', { status: 404 });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    expect(await mgr.get_job('missing')).toBeNull();
  });

  it('throws CloudSchedulerError on 500', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return new Response('boom', { status: 500 });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await expect(mgr.get_job('any')).rejects.toBeInstanceOf(CloudSchedulerError);
  });
});

// ---------------------------------------------------------------------------
// create_job
// ---------------------------------------------------------------------------

describe('create_job', () => {
  it('POSTs to the parent jobs/ collection with base64 payload + topicName built from handler', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs`);
      expect(init.method).toBe('POST');
      captured = JSON.parse(init.body as string);
      return jsonResponse(200, { name: `${PARENT}/jobs/new-job` });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.create_job(
      'new-job',
      '0 10 * * *',
      'cma_session',
      { prompt: 'hello' },
      { description: 'morning report' },
    );
    expect(captured).not.toBeNull();
    const body = captured!;
    expect(body.name).toBe(`${PARENT}/jobs/new-job`);
    expect(body.schedule).toBe('0 10 * * *');
    expect(body.timeZone).toBe('Asia/Tokyo');
    expect(body.description).toBe('morning report');
    expect(body.attemptDeadline).toBe('120s');
    const target = body.pubsubTarget as {
      topicName: string;
      data: string;
      attributes: Record<string, string>;
    };
    expect(target.topicName).toBe('projects/test-proj/topics/cma-scheduler-cma_session');
    // base64 payload decode check
    const decoded = JSON.parse(atob(target.data));
    expect(decoded).toEqual({ prompt: 'hello' });
    expect(target.attributes).toEqual({
      handler: 'cma_session',
      job_id: 'new-job',
      managed_by: 'cma-scheduled',
    });
  });
});

// ---------------------------------------------------------------------------
// pause / resume / delete / run_once
// ---------------------------------------------------------------------------

describe('pause_job / resume_job / delete_job / run_job_once', () => {
  it('calls pause endpoint with POST + empty body', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs/foo:pause`);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{}');
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.pause_job('foo');
  });

  it('calls resume endpoint with POST', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs/foo:resume`);
      expect(init.method).toBe('POST');
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.resume_job('foo');
  });

  it('calls delete endpoint with DELETE', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs/foo`);
      expect(init.method).toBe('DELETE');
      return new Response('', { status: 200 });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.delete_job('foo');
  });

  it('calls run endpoint with POST', async () => {
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      expect(url).toBe(`${SCHEDULER_BASE}/${PARENT}/jobs/foo:run`);
      expect(init.method).toBe('POST');
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.run_job_once('foo');
  });

  it('throws CloudSchedulerError on non-2xx pause', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return new Response('forbidden', { status: 403 });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await expect(mgr.pause_job('foo')).rejects.toBeInstanceOf(CloudSchedulerError);
  });
});

// ---------------------------------------------------------------------------
// update_job
// ---------------------------------------------------------------------------

describe('update_job', () => {
  it('does GET then PATCH with updateMask=schedule,description (auto desc) when only cron changes', async () => {
    let call = 0;
    let patchUrl = '';
    let patchBody: Record<string, unknown> | null = null;
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      call += 1;
      if (call === 1) {
        // GET existing
        expect(init.method ?? 'GET').toBe('GET');
        return jsonResponse(200, {
          name: `${PARENT}/jobs/foo`,
          schedule: '0 8 * * *',
          state: 'ENABLED',
          description: '旧説明',
          pubsubTarget: {
            topicName: 'projects/test-proj/topics/cma-scheduler-cma_session',
            data: btoa(JSON.stringify({ prompt: 'kept' })),
            attributes: { handler: 'cma_session', job_id: 'foo', managed_by: 'cma-scheduled' },
          },
        });
      }
      patchUrl = url;
      patchBody = JSON.parse(init.body as string);
      expect(init.method).toBe('PATCH');
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.update_job('foo', { cron: '0 9 * * *' });
    // updateMask は schedule + description (auto-regen) を含む。
    const u = new URL(patchUrl);
    const mask = u.searchParams.get('updateMask') ?? '';
    expect(mask.split(',').sort()).toEqual(['description', 'schedule']);
    expect(patchBody!.schedule).toBe('0 9 * * *');
    // Python `_make_default_description` byte 等価: `f"{h:02d}:{m:02d}"` → '09:00'
    // (注: Python docstring は '9:00' と書いているが実装は zero-pad で '09:00'。
    //  TS port は実装側に追従する)。
    expect(patchBody!.description).toBe('毎日 09:00 | kept');
  });

  it('PATCH with updateMask=pubsubTarget when only payload changes', async () => {
    let call = 0;
    let patchBody: Record<string, unknown> | null = null;
    let patchUrl = '';
    const fetchMock = makeFetchMock(async (url, init) => {
      if (url === TOKEN_URL) return tokenResponse();
      call += 1;
      if (call === 1) {
        return jsonResponse(200, {
          name: `${PARENT}/jobs/foo`,
          schedule: '* * * * *',
          state: 'ENABLED',
          pubsubTarget: {
            topicName: 'projects/test-proj/topics/cma-scheduler-cma_session',
            data: btoa(JSON.stringify({ old: true })),
            attributes: { handler: 'cma_session', job_id: 'foo', managed_by: 'cma-scheduled' },
          },
        });
      }
      patchUrl = url;
      patchBody = JSON.parse(init.body as string);
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.update_job('foo', { payload: { newPayload: 'yes' } });
    const u = new URL(patchUrl);
    expect(u.searchParams.get('updateMask')).toBe('pubsubTarget');
    const target = patchBody!.pubsubTarget as { data: string; attributes: Record<string, string> };
    expect(JSON.parse(atob(target.data))).toEqual({ newPayload: 'yes' });
    expect(target.attributes.handler).toBe('cma_session');
  });

  it('throws when target job not found', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return new Response('', { status: 404 });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await expect(mgr.update_job('missing', { cron: '0 0 * * *' })).rejects.toBeInstanceOf(
      CloudSchedulerError,
    );
  });

  it('throws when no patch fields provided', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return jsonResponse(200, { name: `${PARENT}/jobs/foo`, schedule: '* * * * *', state: 'ENABLED' });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await expect(mgr.update_job('foo', {})).rejects.toBeInstanceOf(CloudSchedulerError);
  });
});

// ---------------------------------------------------------------------------
// format_job_list — Python byte 等価
// ---------------------------------------------------------------------------

describe('format_job_list (byte 等価)', () => {
  it('returns "定期実行ジョブなし" for empty', () => {
    expect(formatJobList([])).toBe('定期実行ジョブなし');
  });

  it('formats single ENABLED job with description', () => {
    const out = formatJobList([
      {
        job_id: 'daily-report',
        cron: '0 10 * * *',
        handler: 'cma_session',
        description: 'デイリー',
      },
    ]);
    // Python l.339-342:
    //   ・`daily-report` [▶稼働中]
    //     時刻: 毎日 10:00 (cron: `0 10 * * *`)
    //     説明: デイリー
    expect(out).toBe(
      '・`daily-report` [▶稼働中]\n  時刻: 毎日 10:00 (cron: `0 10 * * *`)\n  説明: デイリー',
    );
  });

  it('formats paused job without description omits 説明 line', () => {
    const out = formatJobList([
      {
        job_id: 'paused-x',
        cron: '0 9 * * 1',
        handler: 'cma_session',
        paused: true,
      },
    ]);
    expect(out).toBe('・`paused-x` [⏸停止中]\n  時刻: 毎週月曜 09:00 (cron: `0 9 * * 1`)');
  });

  it('formats multiple jobs separated by newlines', () => {
    const out = formatJobList([
      { job_id: 'a', cron: '0 10 * * *', handler: 'cma_session' },
      { job_id: 'b', cron: '0 15 * * *', handler: 'cma_session' },
    ]);
    expect(out.split('\n').length).toBeGreaterThanOrEqual(4);
    expect(out).toContain('・`a` [▶稼働中]');
    expect(out).toContain('・`b` [▶稼働中]');
  });
});

describe('cronToHuman (Python l.237-307 等価)', () => {
  it('毎日 10:40', () => {
    expect(cronToHuman('40 10 * * *')).toBe('毎日 10:40');
  });

  it('連続時間範囲は 1時間ごと 付記', () => {
    expect(cronToHuman('0 15-17 * * *')).toBe('毎日 15:00, 16:00, 17:00 (1時間ごと)');
  });

  it('複数時刻リスト', () => {
    expect(cronToHuman('0 17,18 * * *')).toBe('毎日 17:00, 18:00');
  });

  it('毎週月曜 09:00 (Python 実装は zero-pad、docstring の "9:00" は drift)', () => {
    expect(cronToHuman('0 9 * * 1')).toBe('毎週月曜 09:00');
  });

  it('毎時 00分 (1日24回)', () => {
    expect(cronToHuman('0 * * * *')).toBe('毎時 00分 (1日24回)');
  });

  it('fallback on malformed cron (returns input)', () => {
    expect(cronToHuman('notacron')).toBe('notacron');
  });
});

// ---------------------------------------------------------------------------
// token cache reuse
// ---------------------------------------------------------------------------

describe('token cache', () => {
  it('reuses cached token across 2 API calls', async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) {
        tokenCalls += 1;
        return tokenResponse(`tok-${tokenCalls}`, 3600);
      }
      apiCalls += 1;
      return jsonResponse(200, { jobs: [] });
    });
    const mgr = createCloudSchedulerManager(makeDeps(fetchMock as unknown as typeof fetch));
    await mgr.list_jobs();
    await mgr.list_jobs();
    expect(tokenCalls).toBe(1); // cached
    expect(apiCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SA JWT 構築失敗
// ---------------------------------------------------------------------------

describe('SA JWT failure', () => {
  it('throws when private_key PEM is empty', async () => {
    const fetchMock = makeFetchMock(async (url) => {
      if (url === TOKEN_URL) return tokenResponse();
      return jsonResponse(200, {});
    });
    const mgr = createCloudSchedulerManager({
      saKeyJson: JSON.stringify({
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: '',
      }),
      project: 'test-proj',
      location: 'asia-northeast1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(mgr.list_jobs()).rejects.toThrow(/private_key/);
  });

  it('throws when saKeyJson is not JSON', async () => {
    const fetchMock = makeFetchMock(async () => tokenResponse());
    const mgr = createCloudSchedulerManager({
      saKeyJson: 'not-json',
      project: 'test-proj',
      location: 'asia-northeast1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(mgr.list_jobs()).rejects.toThrow(/not valid JSON/);
  });
});
