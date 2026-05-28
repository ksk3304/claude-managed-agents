import type { ScheduleJob, ScheduleJobManager } from './schedule-action-marker';

export type NaturalScheduleAction =
  | 'list'
  | 'delete'
  | 'pause'
  | 'resume'
  | 'run_once'
  | 'update';

export interface NaturalScheduleResult {
  handled: boolean;
  text: string;
  action?: NaturalScheduleAction;
  job_id?: string;
}

interface ParsedNaturalScheduleCommand {
  action: NaturalScheduleAction;
  targetQuery: string;
  newCron?: string | undefined;
}

export async function handleNaturalScheduleCommand(
  text: string,
  manager: ScheduleJobManager,
): Promise<NaturalScheduleResult> {
  const parsed = parseNaturalScheduleCommand(text);
  if (!parsed) return { handled: false, text };

  if (parsed.action === 'list') {
    const jobs = await manager.list_jobs();
    return {
      handled: true,
      action: 'list',
      text: `✅ 定期実行ジョブ一覧:\n${manager.format_job_list(jobs)}`,
    };
  }

  const jobs = await manager.list_jobs();
  const target = resolveTargetJob(jobs, parsed.targetQuery);
  if (target.kind === 'none') {
    return {
      handled: true,
      action: parsed.action,
      text: '❌ 対象ジョブが見つかりません。ジョブ一覧で job_id を確認してください。',
    };
  }
  if (target.kind === 'ambiguous') {
    return {
      handled: true,
      action: parsed.action,
      text:
        '❌ 対象ジョブを1件に絞れません。job_id を指定してください。\n' +
        manager.format_job_list(target.jobs),
    };
  }

  const job = target.job;
  if (parsed.action === 'delete') {
    await manager.delete_job(job.job_id);
    return { handled: true, action: 'delete', job_id: job.job_id, text: `✅ \`${job.job_id}\` 削除` };
  }
  if (parsed.action === 'pause') {
    await manager.pause_job(job.job_id);
    return { handled: true, action: 'pause', job_id: job.job_id, text: `✅ \`${job.job_id}\` 一時停止` };
  }
  if (parsed.action === 'resume') {
    await manager.resume_job(job.job_id);
    return { handled: true, action: 'resume', job_id: job.job_id, text: `✅ \`${job.job_id}\` 再開` };
  }
  if (parsed.action === 'run_once') {
    await manager.run_job_once(job.job_id);
    return { handled: true, action: 'run_once', job_id: job.job_id, text: `✅ \`${job.job_id}\` 即時実行` };
  }
  if (parsed.action === 'update') {
    if (!parsed.newCron) {
      return {
        handled: true,
        action: 'update',
        job_id: job.job_id,
        text: `❌ \`${job.job_id}\`: 更新内容が未指定です。変更後の時刻を指定してください。`,
      };
    }
    await manager.update_job(job.job_id, { cron: parsed.newCron });
    return {
      handled: true,
      action: 'update',
      job_id: job.job_id,
      text: `✅ \`${job.job_id}\` 更新 (cron=${parsed.newCron})`,
    };
  }

  return { handled: false, text };
}

export function parseNaturalScheduleCommand(
  text: string,
): ParsedNaturalScheduleCommand | null {
  const normalized = normalizeText(text);
  if (!isScheduleUtterance(normalized)) return null;

  const action = detectAction(normalized);
  if (!action) return null;

  const times = extractDailyTimes(normalized);
  const newCron = action === 'update' && times.length > 0
    ? dailyCron(times[times.length - 1]!)
    : undefined;

  return {
    action,
    targetQuery: normalized,
    newCron,
  };
}

function isScheduleUtterance(text: string): boolean {
  return (
    text.includes('定期') ||
    text.includes('スケジュール') ||
    text.includes('ジョブ') ||
    text.includes('毎朝') ||
    text.includes('毎日') ||
    text.includes('毎週') ||
    text.includes('毎月') ||
    text.includes('毎時')
  );
}

function detectAction(text: string): NaturalScheduleAction | null {
  if (hasAny(text, ['一覧', 'リスト', '見せて', '確認'])) return 'list';
  if (hasAny(text, ['削除', '消して', '消去', 'delete', 'remove'])) return 'delete';
  if (hasAny(text, ['一時停止', '停止', '止めて', '止めろ', 'pause'])) return 'pause';
  if (hasAny(text, ['再開', '再スタート', 'resume'])) return 'resume';
  if (hasAny(text, ['今すぐ実行', '即時実行', 'run_once'])) return 'run_once';
  if (hasAny(text, ['更新', '変更', '変えて', 'ずらして', 'update'])) return 'update';
  return null;
}

function resolveTargetJob(
  jobs: ScheduleJob[],
  query: string,
):
  | { kind: 'one'; job: ScheduleJob }
  | { kind: 'none' }
  | { kind: 'ambiguous'; jobs: ScheduleJob[] } {
  const exact = jobs.filter((job) => query.includes(job.job_id.toLowerCase()));
  if (exact.length === 1) return { kind: 'one', job: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', jobs: exact };

  const wantedTimes = extractDailyTimes(query).map(dailyCron);
  const scored = jobs
    .map((job) => ({ job, score: scoreJob(job, query, wantedTimes) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'none' };
  const bestScore = scored[0]!.score;
  const best = scored.filter((entry) => entry.score === bestScore).map((entry) => entry.job);
  if (best.length === 1) return { kind: 'one', job: best[0]! };
  return { kind: 'ambiguous', jobs: best };
}

function scoreJob(job: ScheduleJob, query: string, wantedCrons: string[]): number {
  const haystack = normalizeText(
    `${job.job_id} ${job.description ?? ''} ${job.handler} ${JSON.stringify(job.payload ?? {})}`,
  );
  let score = 0;
  if (wantedCrons.includes(job.cron)) score += 10;
  if (query.includes('ai') && haystack.includes('ai')) score += 4;
  if (query.includes('ニュース') && haystack.includes('ニュース')) score += 4;
  if (query.includes('朝') && (haystack.includes('morning') || haystack.includes('朝'))) score += 2;
  for (const token of query.split(/[\s　,、。()（）[\]【】`]+/)) {
    if (token.length >= 4 && haystack.includes(token)) score += 1;
  }
  return score;
}

function extractDailyTimes(text: string): Array<{ hour: number; minute: number }> {
  const out: Array<{ hour: number; minute: number }> = [];
  const patterns = [
    /([0-2]?\d)[:：]([0-5]\d)/g,
    /([0-2]?\d)時([0-5]?\d)?分?/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const hour = Number(m[1]);
      const minute = m[2] === undefined || m[2] === '' ? 0 : Number(m[2]);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        out.push({ hour, minute });
      }
    }
  }
  return out;
}

function dailyCron(time: { hour: number; minute: number }): string {
  return `${time.minute} ${time.hour} * * *`;
}

function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
}

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}
