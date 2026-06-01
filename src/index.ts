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
import { generateDailyReports, defaultDateLabel } from "./scheduled/daily-report";
import {
  enqueueMorningBriefSeto,
  MORNING_BRIEF_SETO_CRON,
} from "./scheduled/morning-brief";
import { buildAnthropicClient } from "./lib/session";
import { newClaimOwner, releaseClaim, tryClaim } from "./lib/dedupe";
import {
  recordChatWebhookPayload,
  recordRuntimeEvent,
  pruneObservability,
} from "./lib/observability";
import {
  handleWorkspaceOAuthCallback,
  handleWorkspaceOAuthDevicePoll,
  handleWorkspaceOAuthDeviceStart,
  handleWorkspaceOAuthStart,
} from "./lib/workspace-oauth-flow";
import { ensureMakotoAgentCustomTools } from "./lib/makoto-agent-tools";

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

    if (
      (url.pathname === "/oauth/google/workspace/start" ||
        url.pathname === "/webhooks/oauth/google/workspace/start") &&
      request.method === "GET"
    ) {
      return handleWorkspaceOAuthStart(request, env);
    }

    if (
      (url.pathname === "/oauth/google/workspace/callback" ||
        url.pathname === "/webhooks/oauth/google/workspace/callback") &&
      request.method === "GET"
    ) {
      return handleWorkspaceOAuthCallback(request, env);
    }

    if (
      url.pathname === "/webhooks/oauth/google/workspace/device/start" &&
      request.method === "GET"
    ) {
      return handleWorkspaceOAuthDeviceStart(request, env);
    }

    if (
      url.pathname === "/webhooks/oauth/google/workspace/device/poll" &&
      request.method === "GET"
    ) {
      return handleWorkspaceOAuthDevicePoll(request, env);
    }

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

    // Issue #206 observability smoke endpoint. This deliberately bypasses
    // Google Chat OIDC and exists only for operator-triggered smoke tests.
    // No secret = 404, so production keeps the route inert by default.
    if (
      url.pathname === "/webhooks/issue-206/chat-observe" &&
      request.method === "POST"
    ) {
      return handleIssue206ChatObserve(request, env);
    }

    if (
      url.pathname === "/webhooks/admin/ensure-makoto-agent-tools" &&
      request.method === "POST"
    ) {
      return handleEnsureMakotoAgentTools(request, env);
    }

    return new Response("not found", { status: 404 });
  },

  // Cron dispatcher — wrangler.jsonc `triggers.crons` 経由で複数 schedule を
  // 受ける. `controller.cron` で経路を分岐する:
  //   - `0 4 * * *` (4 AM UTC) → 既存 daily prune (dedupe / webhook_seen)
  //   - `45 5 * * *` (temporary #192 smoke, 05:45 UTC = 14:45 JST)
  //     → daily-report (前日 JST の
  //     セッションログを Memory Store に集約・要約・書き込み)
  //   - `30 23 * * sun-thu` (23:30 UTC Sun-Thu = 平日 08:30 JST)
  //     → morning_brief_seto を Google Chat Queue 経路へ enqueue
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === "45 5 * * *") {
      ctx.waitUntil(runDailyReportCron(env));
      return;
    }
    if (controller.cron === MORNING_BRIEF_SETO_CRON) {
      ctx.waitUntil(enqueueMorningBriefSeto(env));
      return;
    }
    // default = prune cron (`0 4 * * *`). 旧 path を保持.
    const cutoff = Date.now() - ONE_DAY_MS;
    const eventKey = `prune:${controller.cron}:${Date.now()}`;
    ctx.waitUntil(
      (async () => {
        await recordRuntimeEvent(env, {
          eventKey,
          eventType: "cron_prune_start",
          source: "cron.prune",
          detail: { cron: controller.cron, cutoff },
        });
        const detail: Record<string, unknown> = { cron: controller.cron, cutoff };
        try {
          const result = await pruneOlderThan(env.DB, cutoff);
          detail.sentMessages = result.sentMessages;
          console.log(
            `[cron] prune sentMessages=${result.sentMessages} cutoff=${new Date(cutoff).toISOString()}`,
          );
        } catch (error) {
          detail.sentMessagesError =
            error instanceof Error ? error.message : String(error);
          console.error("[cron] prune failed", error);
        }
        // AgentMail bridge prunes — kept on the same daily tick so
        // operators only need to look at one cron when checking
        // dedupe-table growth. `dedupe` ttl is 30 days,
        // `agentmail_webhook_seen` is also 30 days (set on insert).
        try {
          const dedupePruned = await pruneExpiredDedupe(env.DB);
          const seenPruned = await pruneExpiredAgentMailWebhookSeen(env.DB);
          const observabilityPruned = await pruneObservability(env);
          detail.dedupePruned = dedupePruned;
          detail.webhookSeenPruned = seenPruned;
          detail.observabilityPruned = observabilityPruned;
          console.log(
            `[cron] agentmail-prune dedupe=${dedupePruned} webhook_seen=${seenPruned}`,
          );
          console.log(
            `[cron] observability-prune webhook_payloads=${observabilityPruned.webhookPayloads} ` +
              `runtime_events=${observabilityPruned.runtimeEvents} ` +
              `session_binds=${observabilityPruned.sessionBinds} ` +
              `payload_audit=${observabilityPruned.payloadAudit}`,
          );
        } catch (error) {
          detail.agentmailPruneError =
            error instanceof Error ? error.message : String(error);
          console.error("[cron] agentmail prune failed", error);
        }
        const hasError =
          typeof detail.sentMessagesError === "string" ||
          typeof detail.agentmailPruneError === "string";
        await recordRuntimeEvent(env, {
          eventKey,
          eventType: hasError ? "cron_prune_failed" : "cron_prune_done",
          level: hasError ? "error" : "info",
          source: "cron.prune",
          detail,
        });
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
 * `30 15 * * *` (= 00:30 JST) tick で起動する daily-report バッチ.
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
  const eventKey = `daily_report:${dateLabel}:${Date.now()}`;
  console.log(
    `[cron] daily-report start date=${dateLabel} model=${model} dry_run=${dryRun}`,
  );
  await recordRuntimeEvent(env, {
    eventKey,
    eventType: "daily_report_start",
    source: "cron.daily-report",
    detail: { dateLabel, model, dryRun },
  });
  try {
    const result = await generateDailyReports({
      kv: env.MAKOTO_KV,
      client,
      dateLabel,
      model,
      environmentId: env.ENVIRONMENT_ID,
      dryRun,
    });
    console.log(
      `[cron] daily-report done date=${dateLabel} routes=${JSON.stringify(result)}`,
    );
    await recordRuntimeEvent(env, {
      eventKey,
      eventType: "daily_report_done",
      source: "cron.daily-report",
      detail: { dateLabel, model, dryRun, result },
    });
  } catch (error) {
    console.error("[cron] daily-report failed", error);
    await recordRuntimeEvent(env, {
      eventKey,
      eventType: "daily_report_failed",
      level: "error",
      source: "cron.daily-report",
      detail: {
        dateLabel,
        model,
        dryRun,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

interface Issue206DebugBody {
  runId?: string;
  text?: string;
  senderEmail?: string;
  senderName?: string;
  spaceName?: string;
  threadName?: string;
  messageName?: string;
}

async function handleIssue206ChatObserve(request: Request, env: Env): Promise<Response> {
  const expected = (env.MAKOTO_DEBUG_TOKEN ?? "").trim();
  if (!expected) return new Response("not found", { status: 404 });
  const got = (request.headers.get("x-makoto-debug-token") ?? "").trim();
  if (got !== expected) return new Response("not found", { status: 404 });

  let body: Issue206DebugBody;
  try {
    body = (await request.json()) as Issue206DebugBody;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const runId = safeDebugId(body.runId || `issue206-${Date.now()}`);
  const spaceName = body.spaceName || "spaces/issue206-smoke";
  const threadName = body.threadName || `${spaceName}/threads/${runId}`;
  const messageName = body.messageName || `${spaceName}/messages/${runId}`;
  const senderEmail = body.senderEmail || "issue206-smoke@example.com";
  const event: ChatEventPayload = {
    type: "MESSAGE",
    eventTime: new Date().toISOString(),
    space: { name: spaceName, type: "DM", displayName: "Issue 206 smoke" },
    user: { name: body.senderName || "users/issue206", email: senderEmail },
    message: {
      name: messageName,
      sender: {
        name: body.senderName || "users/issue206",
        displayName: "Issue 206 Smoke",
        email: senderEmail,
      },
      text: body.text || "#206 observability smoke",
      thread: { name: threadName },
      annotations: [],
      attachment: [],
    },
  };
  const eventKey = `chat:msgname:${messageName}`;
  const owner = newClaimOwner("issue206-debug");
  const claim = await tryClaim(env.DB, eventKey, owner);
  if (claim.state === "DONE_DUPLICATE" || claim.state === "LEASE_ALIVE") {
    return Response.json({ ok: true, duplicate: true, eventKey, claimState: claim.state });
  }
  if (claim.owner === undefined || claim.version === undefined) {
    return Response.json({ ok: false, error: "unexpected claim state" }, { status: 500 });
  }
  await recordChatWebhookPayload(env, eventKey, event);
  await recordRuntimeEvent(env, {
    eventKey,
    messageId: messageName,
    eventType: "debug_chat_observe_enqueued",
    source: "issue-206-debug-endpoint",
    detail: { run_id: runId, text_chars: event.message?.text?.length ?? 0 },
  });
  const queueMsg: ChatQueueMessage = {
    eventKey,
    receivedAtMs: Date.now(),
    claim: { owner: claim.owner, version: claim.version },
    payload: event,
  };
  try {
    await env.MAKOTO_CHAT_QUEUE.send(queueMsg);
  } catch (err) {
    await releaseClaim(env.DB, eventKey, claim.owner, claim.version);
    await recordRuntimeEvent(env, {
      eventKey,
      messageId: messageName,
      eventType: "debug_chat_observe_enqueue_failed",
      level: "error",
      source: "issue-206-debug-endpoint",
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json({ ok: false, eventKey, error: "queue send failed" }, { status: 500 });
  }
  return Response.json({ ok: true, eventKey, sessionLookup: { spaceName, threadName, senderEmail } });
}

async function handleEnsureMakotoAgentTools(request: Request, env: Env): Promise<Response> {
  const expected = (
    env.MAKOTO_DEBUG_TOKEN ||
    env.MAKOTO_WORKSPACE_OAUTH_ADMIN_TOKEN ||
    ""
  ).trim();
  if (!expected) return new Response("not found", { status: 404 });
  const got = (request.headers.get("x-makoto-debug-token") ?? "").trim();
  if (got !== expected) return new Response("not found", { status: 404 });

  let body: { email?: string; agent_id?: string };
  try {
    body = (await request.json()) as { email?: string; agent_id?: string };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  let agentId = (body.agent_id || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  if (!agentId) {
    if (!email) return Response.json({ ok: false, error: "email or agent_id required" }, { status: 400 });
    const raw = await env.MAKOTO_KV.get(`user_mapping:${email}`);
    if (!raw) return Response.json({ ok: false, error: "user_mapping not found" }, { status: 404 });
    const parsed = JSON.parse(raw) as { agent_id?: unknown };
    if (typeof parsed.agent_id !== "string" || !parsed.agent_id.trim()) {
      return Response.json({ ok: false, error: "agent_id missing in user_mapping" }, { status: 500 });
    }
    agentId = parsed.agent_id.trim();
  }
  const client = buildAnthropicClient(env);
  if (client === null) {
    return Response.json({ ok: false, error: "anthropic client unavailable" }, { status: 500 });
  }
  const agent = await client.beta.agents.retrieve(agentId);
  const version = typeof agent.version === "number" ? agent.version : null;
  if (version === null) {
    return Response.json({ ok: false, error: "agent version missing" }, { status: 500 });
  }
  const currentTools = (agent as { tools?: unknown }).tools;
  const ensured = ensureMakotoAgentCustomTools(currentTools);
  if (ensured.added.length === 0) {
    return Response.json({
      ok: true,
      agent_id: agentId,
      changed: false,
      version,
      present: ensured.present,
    });
  }
  const updated = await client.beta.agents.update(agentId, {
    version,
    tools: ensured.tools as Parameters<typeof client.beta.agents.update>[1]["tools"],
  });
  return Response.json({
    ok: true,
    agent_id: agentId,
    changed: true,
    before_version: version,
    after_version: updated.version,
    added: ensured.added,
    present: ensured.present,
  });
}

function safeDebugId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80) || "issue206-smoke";
}
