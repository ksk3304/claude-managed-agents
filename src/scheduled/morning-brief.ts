import type { ChatEventPayload, ChatQueueMessage } from '../webhooks/google-chat';
import { newClaimOwner, releaseClaim, tryClaim } from '../lib/dedupe';
import { recordRuntimeEvent } from '../lib/observability';

export const MORNING_BRIEF_SETO_CRON = '30 23 * * sun-thu';
export const MIDDAY_BRIEF_SETO_CRON = '0 4 * * mon-fri';
export const MORNING_BRIEF_SETO_JOB_ID = 'morning_brief_seto';
export const MIDDAY_BRIEF_SETO_JOB_ID = 'midday_brief_seto';
export const MORNING_BRIEF_SETO_SPACE = 'spaces/rKtECyAAAAE';
export const MORNING_BRIEF_SETO_EMAIL = 'k.seto@makotoprime.com';

const BRIEF_OUTPUT_RULES = `# 出力規約（最優先・絶対厳守）
- あなたが出力する最初の可視テキスト行は、必ず次の 1 行だけにする: ===BRIEF_FINAL===
- \`===BRIEF_FINAL===\` は出力全体で 1 回だけ書く。思考中にも本文中にも、同じ文字列を二度と書かない。
- それ以前にテキスト（思考・前置き・進捗・「調べます」「揃いました」等）を一切書かない。情報収集はツール呼び出しで行い、テキストには出さない。
- ===BRIEF_FINAL=== の行より後に、ブリーフ本文だけを 1 回だけ書く。
- ===BRIEF_FINAL=== より後に本文以外を一切書かない。締めの挨拶・完成宣言・補足・自己言及・「投稿します」「送ります」「以下が本文です」等を書かない。本文を書き終えたらそこで出力を終える。
- 本文を 2 回以上書かない（下書きと清書のような重複出力をしない）。
- 万一マーカーを出せない事情があっても、代わりに別の文章を書かない（マーカー＋本文のみが唯一許される出力）。
- 本文は 2500 字以内（最大でも 3000 字）。超えそうなら各セクションを短く要約して収める。

# 本文に内部状態・内部名を書かない（絶対厳守）
- ツール / API / store 名 / session / attach / 参照可否 などの内部事情・内部名称を本文に一切書かない。
- あるセクションのデータが取得できなかった場合、その見出しの下に「（今回は該当データなし）」とだけ書き、理由・内部状態・できなかった事情は書かない。
- 「attach されていない」「参照できません」「memory store」「一時的に」「エラー」等の語を本文に出さない。`;

const ACTIVE_TASKS_READING_HINT = `# TODO読み取り方針（cc-secretary 参考）
- ActiveTasks.md は、cc-secretary の Markdown TODO 管理の考え方を圧縮移植したものとして読む。
- 可能なら「最優先」「通常」「余裕があれば」「完了」「メモ・振り返り」の見出しを前提に整理する。
- [ ] は未完了、[x] は完了として扱う。
- 「最優先」は今日中・重要、「通常」は今週中、「余裕があれば」は低優先度として扱う。
- 期限切れ・当日期限・最優先を先に拾う。
- 各TODOに対して、MAKOTOくんが次に手伝える具体行動（下書き、調査、整理、候補出し、文案化、リマインド等）を考える。
- ActiveTasks.md が別形式でも、既存内容を壊さず読み、上記構造に近いものとして解釈する。
- cc-secretary、ActiveTasks.md、見出し名、ファイル名、取得経路は本文に出さない。`;

const CALENDAR_READING_HINT = `# 予定読み取り方針
- 今日の予定は Google Calendar の予定一覧を確認して要約する。
- 予定は TODO と混ぜず、独立した「今日の予定」または「午後の予定」セクションで出す。
- 予定は最大 5 件。時刻、タイトル、必要なら移動/準備/会議前確認を短く添える。
- 予定が多い場合は、直近・重要・準備が必要なものを優先し、残りは件数だけ短く触れる。
- カレンダーの内部 tool 名、取得経路、失敗理由は本文に書かない。`;

const TODO_HELP_PROPOSAL_HINT = `# 手伝い提案方針
- TODOを単に列挙せず、各TODOに対して「MAKOTOくんができること」を短く添える。
- 例: 下書き作成、論点整理、資料検索、候補出し、メール文案、議事録整理、次アクション分解、リマインド文案。
- ユーザーが「これやって」「詳しく」「どう進める?」と返したら、そのTODOについて通常会話で続きの支援に入れる前提で書く。
- 外部送信、予定作成、Issue起票、ファイル削除など副作用がある行動は、提案で止める。承認後に実行する。`;

export const MORNING_BRIEF_SETO_PROMPT = `瀬戸さん向けの朝ブリーフを作成するタスク。情報収集（memory / issue 一覧 / session-log / Agent Core support の ActiveTasks.md 等の参照）はツールで自由に行ってよいが、テキストとして文章を出力するのは最終ブリーフ 1 回のみとする。

${BRIEF_OUTPUT_RULES}

${ACTIVE_TASKS_READING_HINT}

${CALENDAR_READING_HINT}

${TODO_HELP_PROPOSAL_HINT}

# ブリーフ本文（6 セクション）
1. 直近 3 日分の日報サマリ（共有 / DM を区別して 1 行ずつ）
2. 共有スペースで MAKOTOくん の返信待ち（最後の発話が人間）のスレッド
3. 今日の予定（Google Calendar から今日の予定を最大 5 件。準備が必要なものは短く補足。無ければ「該当なし」）
4. 今日のTODO（最優先・期限切れ・当日期限を中心に最大 5 件。各項目に「MAKOTOくんができること」を短く添える。無ければ「該当なし」）
5. status=open かつ 優先度=high の issue（無ければ「該当なし」）
6. 瀬戸さんへの推奨アクション 1〜3 件（上記 1〜5 から導出。根拠を 1 行ずつ）

# 収集の手がかり（内部メモ。本文には絶対に書かない）
- 1: daily-report-shared-store / daily-report-dm-store を参照
- 2: session-log-shared-store から「最後の発話が人間」を抽出
- 3: calendar_list_events で今日 00:00〜23:59 JST の予定を参照
- 4: Agent Core support の ActiveTasks.md を参照。これはTODOの正本。会話中に更新される前提なので、この時点のスナップショットとして読む
- 5: open_issues_v2（read scope）を参照
これらの参照先名・ツール名・取得経路は収集に使うだけ。ブリーフ本文には一切書かない。

- 末尾に「気になる点」を 1〜2 行添えてよい（任意）。ただし瀬戸さんの仕事の中身に関する指摘に限り、ツール / システムの不具合や自分の処理状況の話は書かない。`;

export const MIDDAY_BRIEF_SETO_PROMPT = `瀬戸さん向けの13時TODOチェックを作成するタスク。Agent Core support の ActiveTasks.md を正本として、この時点のスナップショットを読み、午後に向けた提案だけを短く出す。情報収集はツールで自由に行ってよいが、テキストとして文章を出力するのは最終ブリーフ 1 回のみとする。

${BRIEF_OUTPUT_RULES}

${ACTIVE_TASKS_READING_HINT}

${CALENDAR_READING_HINT}

${TODO_HELP_PROPOSAL_HINT}

# ブリーフ本文（5 セクション）
1. 午後の予定（Google Calendar から13時以降の予定を最大 5 件。準備が必要なものは短く補足。無ければ「該当なし」）
2. 13時時点のTODO要約（最優先・期限切れ・当日期限・午前中に変化した項目を最大 5 件。各項目に「MAKOTOくんができること」を短く添える。無ければ「該当なし」）
3. 午前中に進んだ / 変わった可能性があること（会話・日報・session-log から分かる範囲で短く）
4. 午後にMAKOTOくんが手伝えること 1〜3 件
5. 瀬戸さんへの次アクション 1〜3 件

# 収集の手がかり（内部メモ。本文には絶対に書かない）
- ActiveTasks.md を正本として読む。朝8:30の内容を暗記で再掲せず、この13時時点の内容を使う。
- calendar_list_events で今日 13:00〜23:59 JST の予定を参照し、TODOとは別セクションで扱う。
- session-log / 直近会話 / issue 一覧は補助情報として使ってよい。
- ActiveTasks.md そのもののファイル名・格納場所・取得経路は本文に書かない。
- 勝手に Issue 起票、メール送信、Chat 投稿、外部操作をしない。必要なら「手伝えます」と提案で止める。`;

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface MorningBriefEnqueueResult {
  kind: 'enqueued' | 'duplicate' | 'lease_alive' | 'failed';
  eventKey: string;
}

interface BriefSpec {
  jobId: string;
  prompt: string;
  ownerPrefix: string;
  eventTypePrefix: string;
  source: string;
}

const MORNING_SPEC: BriefSpec = {
  jobId: MORNING_BRIEF_SETO_JOB_ID,
  prompt: MORNING_BRIEF_SETO_PROMPT,
  ownerPrefix: 'cron-morning-brief-seto',
  eventTypePrefix: 'scheduled_morning_brief',
  source: 'cron.morning-brief',
};

const MIDDAY_SPEC: BriefSpec = {
  jobId: MIDDAY_BRIEF_SETO_JOB_ID,
  prompt: MIDDAY_BRIEF_SETO_PROMPT,
  ownerPrefix: 'cron-midday-brief-seto',
  eventTypePrefix: 'scheduled_midday_brief',
  source: 'cron.midday-brief',
};

export async function enqueueMorningBriefSeto(
  env: Env,
  nowMs: number = Date.now(),
): Promise<MorningBriefEnqueueResult> {
  return enqueueSetoBrief(env, MORNING_SPEC, nowMs);
}

export async function enqueueMiddayBriefSeto(
  env: Env,
  nowMs: number = Date.now(),
): Promise<MorningBriefEnqueueResult> {
  return enqueueSetoBrief(env, MIDDAY_SPEC, nowMs);
}

async function enqueueSetoBrief(
  env: Env,
  spec: BriefSpec,
  nowMs: number,
): Promise<MorningBriefEnqueueResult> {
  const dateLabel = jstDateLabel(nowMs);
  const eventKey = `scheduled:${spec.jobId}:${dateLabel}:${nowMs}`;
  const owner = newClaimOwner(spec.ownerPrefix);
  const claim = await tryClaim(env.DB, eventKey, owner);
  if (claim.state === 'DONE_DUPLICATE') return { kind: 'duplicate', eventKey };
  if (claim.state === 'LEASE_ALIVE') return { kind: 'lease_alive', eventKey };
  if (claim.owner === undefined || claim.version === undefined) {
    return { kind: 'failed', eventKey };
  }

  const payload = buildSetoBriefChatEvent(nowMs, eventKey, spec.prompt);
  const queueMsg: ChatQueueMessage = {
    eventKey,
    receivedAtMs: nowMs,
    claim: { owner: claim.owner, version: claim.version },
    payload,
  };
  await recordRuntimeEvent(env, {
    eventKey,
    messageId: payload.message?.name,
    eventType: `${spec.eventTypePrefix}_enqueue_start`,
    source: spec.source,
    detail: { job_id: spec.jobId, date_label: dateLabel },
  });

  try {
    await env.MAKOTO_CHAT_QUEUE.send(queueMsg);
  } catch (error) {
    await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: payload.message?.name,
      eventType: `${spec.eventTypePrefix}_enqueue_failed`,
      level: 'error',
      source: spec.source,
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    return { kind: 'failed', eventKey };
  }

  await recordRuntimeEvent(env, {
    eventKey,
    messageId: payload.message?.name,
    eventType: `${spec.eventTypePrefix}_enqueued`,
    source: spec.source,
    detail: {
      job_id: spec.jobId,
      date_label: dateLabel,
      text_chars: payload.message?.text?.length ?? 0,
    },
  });
  return { kind: 'enqueued', eventKey };
}

export function buildMorningBriefChatEvent(
  nowMs: number,
  eventKey: string,
): ChatEventPayload {
  return buildSetoBriefChatEvent(nowMs, eventKey, MORNING_BRIEF_SETO_PROMPT);
}

export function buildMiddayBriefChatEvent(
  nowMs: number,
  eventKey: string,
): ChatEventPayload {
  return buildSetoBriefChatEvent(nowMs, eventKey, MIDDAY_BRIEF_SETO_PROMPT);
}

function buildSetoBriefChatEvent(
  nowMs: number,
  eventKey: string,
  prompt: string,
): ChatEventPayload {
  const messageName = `${MORNING_BRIEF_SETO_SPACE}/messages/${safeMessageId(eventKey)}`;
  return {
    type: 'MESSAGE',
    eventTime: new Date(nowMs).toISOString(),
    space: {
      name: MORNING_BRIEF_SETO_SPACE,
      type: 'DM',
      displayName: '瀬戸さん DM',
    },
    user: {
      name: 'users/scheduled-morning-brief-seto',
      displayName: 'MAKOTO Scheduler',
      email: MORNING_BRIEF_SETO_EMAIL,
    },
    message: {
      name: messageName,
      sender: {
        name: 'users/scheduled-morning-brief-seto',
        displayName: 'MAKOTO Scheduler',
        email: MORNING_BRIEF_SETO_EMAIL,
      },
      text: `${todayPrefix(nowMs)}${prompt}`,
      annotations: [],
      attachment: [],
    },
  };
}

function todayPrefix(nowMs: number): string {
  const shifted = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const weekday = WEEKDAY_JP[shifted.getUTCDay()];
  return (
    `今日は ${y}-${m}-${d} (${weekday}) JST です。` +
    '本セッションは本日のこの時刻の定期実行発火分です。' +
    'prompt 内の「今日」「昨日」「直近 24h」「直近 N 日」はこの日付を基準に解釈すること。\n\n'
  );
}

function jstDateLabel(nowMs: number): string {
  const shifted = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeMessageId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
}
