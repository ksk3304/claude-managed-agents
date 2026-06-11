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
- ===BRIEF_FINAL=== の行より後に、内部保存用 marker を 1 行だけ書き、その後にユーザー向け本文を書く。
- 内部保存用 marker は \`BRIEF_SUGGESTION:{...}\` の 1 行 JSON。ユーザー向けには表示されない前提だが、本文では絶対に言及しない。
- ===BRIEF_FINAL=== より後に、内部保存用 marker と本文以外を一切書かない。締めの挨拶・完成宣言・補足・自己言及・「投稿します」「送ります」「以下が本文です」等を書かない。本文を書き終えたらそこで出力を終える。
- 本文を 2 回以上書かない（下書きと清書のような重複出力をしない）。
- 万一マーカーを出せない事情があっても、代わりに別の文章を書かない（マーカー＋本文のみが唯一許される出力）。
- 本文は 100〜140 字程度。最大でも 180 字。箇条書き・見出しは禁止。

# 本文に内部状態・内部名を書かない（絶対厳守）
- ツール / API / store 名 / session / attach / 参照可否 などの内部事情・内部名称を本文に一切書かない。
- セクション見出しを書かない。
- 「attach されていない」「参照できません」「memory store」「一時的に」「エラー」「D1」「BRIEF_SUGGESTION」等の語を本文に出さない。`;

const TODO_SOURCE_READING_HINT = `# TODO読み取り方針（cc-secretary 参考）
- TODO / issue 風タスクの正本は Google Drive のスプレッドシート「まことくん開発管理」として扱う。
- まず Drive で表題を検索し、見つかったスプレッドシートを読む。表題ゆれがある場合は「まことくん」「MAKOTO」「開発」「管理」等で探す。
- 行の解釈は表のヘッダに従う。状態 / status / 完了 / close / 対応状況 などの列があれば、完了・終了・closed・done・対応済み等を除外し、未完了・open・未着手・進行中・要対応を候補にする。
- 優先度 / 期限 / issue番号 / 担当 / 次アクション / メモ等の列があれば、今日進める候補の判断材料にする。
- ActiveTasks.md は会話中に更新される補助メモ / scratchpad として読む。開発管理表より優先しないが、直近会話での優先度変更・一時メモ・ユーザーの言い換えがある場合は補助情報として反映する。
- 直近会話、今日の予定、未完了行、期限、open issue をすべて候補材料として読む。
- cc-secretary、スプレッドシート名、ActiveTasks.md、ヘッダ名、ファイル名、取得経路は本文に出さない。ユーザー向けには「開発管理表」「TODO」程度の自然な表現にする。`;

const CALENDAR_READING_HINT = `# 予定読み取り方針
- 今日の予定は Google Calendar の予定一覧を確認し、TODO提案の優先順位判断に使う。
- 定期通知本文では予定一覧を出さない。予定起因で今すぐ下ごしらえできる場合だけ、提案本文に自然に織り込む。
- カレンダーの内部 tool 名、取得経路、失敗理由は本文に書かない。`;

const TODO_HELP_PROPOSAL_HINT = `# 一手提案方針
- TODOを網羅列挙しない。選ぶのは基本 1 件。AIが大きく手間を減らせる案件が明確に 2 件ある時だけ 2 件まで。
- 主基準は「MAKOTOくんが手伝うことで瀬戸さんの負担をどれだけ減らせるか」。次に緊急度。
- 支援内容だけでなく、手伝った後の状態・ゴールを短く書く。「僕が下ごしらえすると、○○まで持っていけます」の形。
- 緊急度は高いが大きく代替しにくい案件は、主提案にせず最後の一文でだけ触れる。例: 「なお○○は締切が近いです。大きく代替はできませんが、確認観点整理ならすぐ手伝えます。」
- 「一言で頼める返答例」「なぜ今」「スコア」「他にもあります」は書かない。
- ユーザーが「じゃあお願い」と返したら、内部保存した task / support_action / promised_outcome を前提に通常会話で支援へ入れる。
- 外部送信、予定作成、Issue起票、ファイル削除など副作用がある行動は、提案で止める。承認後に実行する。

# 内部採点方針（本文には書かない）
- 直近会話での困りごと・やる気配: 10点満点
- 今日の予定準備: 9点満点
- 開発管理表 / ActiveTasks 未完了: 8点満点
- 期限 / 緊急度: 7点満点
- open issue 関連度: 6点満点
- AI負担軽減度: 10点満点
- 全候補を採点し、総合点とAI負担軽減度が高いものを優先する。ハード制約で0件にしない。

# 内部保存用 marker
- 本文の前に必ず 1 行で出す。JSON 内に改行を入れない。
- 形式:
BRIEF_SUGGESTION:{"items":[{"rank":1,"task_key":"短い安定ID","task_title":"対象タスク","support_action":"MAKOTOくんができること","promised_outcome":"手伝った後の状態","urgency_note":"任意。緊急だが主提案にしない補足"}]}
- items は 1 件を基本、最大 2 件。
- marker の内容と本文の約束を一致させる。本文で期待させたことは promised_outcome に必ず入れる。`;

export const MORNING_BRIEF_SETO_PROMPT = `瀬戸さん向けの朝ブリーフを作成するタスク。情報収集（memory / issue 一覧 / session-log / Google Drive の開発管理表 / Agent Core support の ActiveTasks.md 等の参照）はツールで自由に行ってよいが、テキストとして文章を出力するのは最終ブリーフ 1 回のみとする。

${BRIEF_OUTPUT_RULES}

${TODO_SOURCE_READING_HINT}

${CALENDAR_READING_HINT}

${TODO_HELP_PROPOSAL_HINT}

# 本文
- 必ず「瀬戸さん、おはようございます。」で始める。
- 見出し・箇条書き・一覧は禁止。自然な会話 1 段落。
- 主提案は 1 件中心。「僕が何をできるか」と「そうすると何ができた状態になるか」を入れる。
- 日報サマリ、返信待ち、予定一覧、high issue一覧、TODO一覧は出さない。
- 100〜140 字程度。最大 180 字。

# 収集の手がかり（内部メモ。本文には絶対に書かない）
- 1: daily-report-shared-store / daily-report-dm-store を参照
- 2: session-log-shared-store から「最後の発話が人間」を抽出
- 3: calendar_list_events で今日 00:00〜23:59 JST の予定を参照
- 4: Google Drive で「まことくん開発管理」を探し、未完了行をTODO正本として読む。ActiveTasks.md は直近会話の補助メモとして読む
- 5: open_issues_v2（read scope）を参照
これらの参照先名・ツール名・取得経路は収集に使うだけ。ブリーフ本文には一切書かない。
`;

export const MIDDAY_BRIEF_SETO_PROMPT = `瀬戸さん向けの13時TODOチェックを作成するタスク。Google Drive の開発管理表をTODO正本、Agent Core support の ActiveTasks.md を補助メモとして、この時点のスナップショットを読み、午後に向けた提案だけを短く出す。情報収集はツールで自由に行ってよいが、テキストとして文章を出力するのは最終ブリーフ 1 回のみとする。

${BRIEF_OUTPUT_RULES}

${TODO_SOURCE_READING_HINT}

${CALENDAR_READING_HINT}

${TODO_HELP_PROPOSAL_HINT}

# 本文
- 朝とそっくり同じ提案になるなら、本文を出さず \`===BRIEF_FINAL===\` の次行に \`===BRIEF_SKIP===\` だけ出して終える。BRIEF_SUGGESTION は出さない。
- 出す場合は必ず「瀬戸さん、お疲れ様です。」で始める。
- 見出し・箇条書き・一覧は禁止。自然な会話 1 段落。
- 13時時点で状況が動いた、午後に新しい支援価値がある、または今なら下ごしらえできる案件だけを扱う。
- 主提案は 1 件中心。「僕が何をできるか」と「そうすると何ができた状態になるか」を入れる。
- 午後予定一覧、TODO一覧、朝の再掲は出さない。
- 100〜140 字程度。最大 180 字。

# 収集の手がかり（内部メモ。本文には絶対に書かない）
- Google Drive の開発管理表をTODO正本として読む。朝8:30の内容を暗記で再掲せず、この13時時点の未完了行を使う。
- calendar_list_events で今日 13:00〜23:59 JST の予定を参照し、提案優先度の判断材料にする。
- ActiveTasks.md / session-log / 直近会話 / issue 一覧は補助情報として使ってよい。
- スプレッドシート名、ActiveTasks.md そのもののファイル名・格納場所・取得経路は本文に書かない。
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
