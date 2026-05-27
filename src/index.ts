// Cloudflare Worker entrypoint — MAKOTOくん R-Mail bridge (Issue #186 v4).
//
// v4 cloud-env-only path: the Worker is a thin bridge that
//   1. accepts AgentMail svix webhooks at `POST /webhooks/agentmail`,
//   2. enqueues each delivery to Cloudflare Queues,
//   3. consumes the queue and dispatches via `agentmailDispatch`
//      (sender resolution → sessions.create (cloud env) → custom_tool_use
//       loop → EMAIL_SEND marker parse → AgentMail send).
//
// All self-hosted sandbox machinery (Cloudflare Containers MicroVM
// Sandbox, IsolateRunner DO, agent_backends D1 table, Anthropic Console
// webhook drainWork, agent management /api/* endpoints, frontend ASSETS
// surface) was removed in v4 廃棄 — Anthropic's `type: cloud` environment
// runs the agent server-side, so the Worker no longer hosts a sandbox.
// See worktrees/issue-186/diary/2026/05/24/issue-186-cloudflare-phase2-
// rmail-bridge-ts/plan-draft-v4-cloud-env-only.md §5.2.1 廃棄対象.
import { handleAgentMailWebhook } from "./webhooks/agentmail";
import {
  handleAgentMailQueue,
  type AgentMailDispatcher,
} from "./queue/agentmail-consumer";
import { agentmailDispatch } from "./queue/agentmail-dispatch";
import type { AgentMailQueueMessage } from "./webhooks/agentmail";
import { handleGoogleChatWebhook } from "./webhooks/google-chat";
import type { ChatEventPayload, ChatQueueMessage } from "./webhooks/google-chat";
import { handleChatQueue } from "./queue/chat-event-handler";
import { ThreadLock } from "./durable-objects/thread-lock";
import { OAuthLease } from "./durable-objects/oauth-lease";
import {
  pruneExpiredAgentMailWebhookSeen,
  pruneOlderThan,
} from "./storage";
import { pruneExpiredDedupe } from "./lib/dedupe";
import { newClaimOwner, releaseClaim, tryClaim } from "./lib/dedupe";
import { generateDailyReports, defaultDateLabel } from "./scheduled/daily-report";
import { buildAnthropicClient } from "./lib/session";

// `ThreadLock` is the per-RFC-822-message exclusion DO that the
// AgentMail Queue consumer takes before any `sessions.create` /
// AgentMail send work. Re-exported so wrangler can bind it; one DO
// per thread key via `MAKOTO_THREAD_LOCK.idFromName(eventKey)`.
//
// `OAuthLease` is the per-user Google OAuth refresh lease + token
// cache DO. One instance per user (`idFromName(userSlug)`) — see
// `src/durable-objects/oauth-lease.ts` for the contract.
export { ThreadLock, OAuthLease };

// Layer 7-3 wire-up: route AgentMail Queue deliveries through the real
// session / tool-dispatch / EMAIL_SEND pipeline. `agentmailDispatch`
// owns sender resolution, sessions.create or thread continuation,
// `agent.custom_tool_use` self-dispatch via the MAKOTO tool router,
// EMAIL_SEND marker parsing, redactor scrub, and AgentMail send +
// `sent_messages` recording. The framing layer (consumer) still owns
// claim / lease / DO lock / commit_done.
const agentmailDispatcher: AgentMailDispatcher = agentmailDispatch;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // AgentMail inbound webhook (svix protocol).
    if (
      url.pathname === "/webhooks/agentmail" &&
      request.method === "POST"
    ) {
      return handleAgentMailWebhook(request, env);
    }

    // Google Chat reactive bot HTTPS push endpoint (Issue #186 #5
    // Phase A). Replaces the Cloud Run Pub/Sub pull path
    // (`scripts/cma_gchat_bot.py:_handle_event`). JWT verify + dedupe +
    // Queue enqueue here; heavy session orchestration runs in the
    // Queue consumer (Phase B, stubbed today).
    if (
      url.pathname === "/webhooks/google-chat" &&
      request.method === "POST"
    ) {
      return handleGoogleChatWebhook(request, env);
    }

    if (
      url.pathname === "/webhooks/issue-202/chat-observe" &&
      request.method === "POST"
    ) {
      return handleIssue202ChatObserve(request, env);
    }

    return new Response("not found", { status: 404 });
  },

  // Cron dispatcher — wrangler.jsonc `triggers.crons` 経由で複数 schedule を
  // 受ける. `controller.cron` で経路を分岐する:
  //   - `0 4 * * *` (4 AM UTC) → 既存 daily prune (dedupe / webhook_seen)
  //   - `0 14 * * *` (14:00 UTC = 23:00 JST) → daily-report (前日 JST の
  //     セッションログを Memory Store に集約・要約・書き込み)
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === "0 14 * * *") {
      ctx.waitUntil(runDailyReportCron(env));
      return;
    }
    // default = prune cron (`0 4 * * *`). 旧 path を保持.
    const cutoff = Date.now() - ONE_DAY_MS;
    ctx.waitUntil(
      (async () => {
        try {
          const result = await pruneOlderThan(env.DB, cutoff);
          console.log(
            `[cron] prune sentMessages=${result.sentMessages} cutoff=${new Date(cutoff).toISOString()}`,
          );
        } catch (error) {
          console.error("[cron] prune failed", error);
        }
        // AgentMail bridge prunes — kept on the same daily tick so
        // operators only need to look at one cron when checking
        // dedupe-table growth. `dedupe` ttl is 30 days,
        // `agentmail_webhook_seen` is also 30 days (set on insert).
        try {
          const dedupePruned = await pruneExpiredDedupe(env.DB);
          const seenPruned = await pruneExpiredAgentMailWebhookSeen(env.DB);
          console.log(
            `[cron] agentmail-prune dedupe=${dedupePruned} webhook_seen=${seenPruned}`,
          );
        } catch (error) {
          console.error("[cron] agentmail prune failed", error);
        }
      })(),
    );
  },

  // Cloudflare Queues consumer entrypoint. Bound via
  // `wrangler.jsonc` `queues.consumers[].queue = "<name>"`.
  // Long-running session / EMAIL_SEND / AgentMail send work runs here
  // (Queues consumer wall budget = 15 min, CPU = 5 min), well past the
  // Workers HTTP `waitUntil` 30-second ceiling that constrained the
  // older Cloud Run path.
  //
  // Dispatch by `batch.queue` so a single `queue` export can serve
  // multiple bindings (AgentMail + Google Chat).
  async queue(
    batch: MessageBatch<AgentMailQueueMessage | ChatQueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (batch.queue === "makoto-chat-queue") {
      // Phase B (= sessions.create + tool dispatch + 各 marker 解析 +
      // current space 投稿 + session-log + commitDone) を委譲する。
      // `handleChatQueue` 内で msg.ack / msg.retry を判定するので
      // ここでは return のみ。
      await handleChatQueue(
        batch as MessageBatch<ChatQueueMessage>,
        env,
        ctx,
      );
      return;
    }
    await handleAgentMailQueue(
      batch as MessageBatch<AgentMailQueueMessage>,
      env,
      ctx,
      agentmailDispatcher,
    );
  },
};

// ----------------------------------------------------------------------------
// daily-report cron runner
// ----------------------------------------------------------------------------

/**
 * `0 14 * * *` (= 23:00 JST) tick で起動する daily-report バッチ.
 * `src/scheduled/daily-report.ts:generateDailyReports` に処理を委譲する.
 * Anthropic client の組み立て / env override 解決 / 起動ログだけここで行う.
 */
async function runDailyReportCron(env: Env): Promise<void> {
  const client = buildAnthropicClient(env);
  if (client === null) {
    console.error("[cron] daily-report skipped: Anthropic API key missing");
    return;
  }
  const model = env.DAILY_REPORT_MODEL || "claude-haiku-4-5";
  const dateLabel = env.DAILY_REPORT_DATE || defaultDateLabel(new Date());
  const dryRun = env.DAILY_REPORT_DRY_RUN === "1";
  console.log(
    `[cron] daily-report start date=${dateLabel} model=${model} dry_run=${dryRun}`,
  );
  try {
    const result = await generateDailyReports({
      kv: env.MAKOTO_KV,
      client,
      dateLabel,
      model,
      dryRun,
    });
    console.log(
      `[cron] daily-report done date=${dateLabel} routes=${JSON.stringify(result)}`,
    );
  } catch (error) {
    console.error("[cron] daily-report failed", error);
  }
}

interface Issue202DiagnosticBody {
  runId?: unknown;
  text?: unknown;
  senderEmail?: unknown;
  spaceName?: unknown;
  threadName?: unknown;
}

async function handleIssue202ChatObserve(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = env.MAKOTO_DEBUG_TOKEN?.trim();
  if (!token) {
    return new Response("not found", { status: 404 });
  }
  if (request.headers.get("x-makoto-debug-token") !== token) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Issue202DiagnosticBody;
  try {
    body = (await request.json()) as Issue202DiagnosticBody;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  const senderEmail =
    typeof body.senderEmail === "string" ? body.senderEmail.trim() : "";
  const spaceName =
    typeof body.spaceName === "string" ? body.spaceName.trim() : "";
  const threadName =
    typeof body.threadName === "string" && body.threadName.trim()
      ? body.threadName.trim()
      : `${spaceName}/threads/${runId}`;

  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(runId)) {
    return Response.json({ error: "invalid runId" }, { status: 400 });
  }
  if (!text.trim() || !senderEmail || !spaceName || !threadName) {
    return Response.json(
      { error: "text, senderEmail, spaceName, threadName required" },
      { status: 400 },
    );
  }

  const messageName = `${spaceName}/messages/${runId}`;
  const eventKey = `chat:msgname:${messageName}`;
  const owner = newClaimOwner(env.WORKER_INSTANCE_ID ?? "issue-202-debug");
  const claim = await tryClaim(env.DB, eventKey, owner);
  if (claim.state === "DONE_DUPLICATE" || claim.state === "LEASE_ALIVE") {
    console.log(`[issue-202-debug] duplicate state=${claim.state} eventKey=${eventKey}`);
    return Response.json({ ok: true, state: claim.state, eventKey });
  }
  if (claim.owner === undefined || claim.version === undefined) {
    return Response.json({ error: "unexpected claim state" }, { status: 500 });
  }

  const payload: ChatEventPayload = {
    type: "MESSAGE",
    eventTime: new Date().toISOString(),
    message: {
      name: messageName,
      sender: {
        name: "users/issue-202-debug",
        displayName: "Issue 202 Diagnostic",
        email: senderEmail,
        type: "HUMAN",
      },
      text,
      thread: { name: threadName },
    },
    space: {
      name: spaceName,
      type: "DM",
      displayName: "Issue 202 Diagnostic",
    },
    user: {
      name: "users/issue-202-debug",
      displayName: "Issue 202 Diagnostic",
      email: senderEmail,
    },
  };

  const queueMsg: ChatQueueMessage = {
    eventKey,
    receivedAtMs: Date.now(),
    claim: { owner: claim.owner, version: claim.version },
    payload,
  };

  try {
    await env.MAKOTO_CHAT_QUEUE.send(queueMsg);
  } catch (err) {
    await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
    console.error(
      `[issue-202-debug] queue-send failed eventKey=${eventKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: "queue send failed" }, { status: 500 });
  }

  console.log(`[issue-202-debug] enqueued eventKey=${eventKey}`);
  return Response.json({ ok: true, state: claim.state, eventKey, messageName });
}
