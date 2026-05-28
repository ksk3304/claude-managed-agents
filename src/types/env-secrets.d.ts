// Secret-shaped Env fields that `wrangler types` cannot infer from
// `wrangler.jsonc` (because they're provisioned via `wrangler secret put`
// or `.dev.vars`, not declared as `vars`). Declaration-merge them into
// the auto-generated `Cloudflare.Env` so the bridge code can reference
// `env.ANTHROPIC_API_KEY` etc. without `any` casts.
//
// Provisioning:
//   - production: `wrangler secret put <NAME>` (per environment)
//   - local dev: `.dev.vars` (already in .gitignore)
//
// Keep this list in sync with what the source actually reads. New
// secrets must be added here AND set via `wrangler secret put` before
// the next deploy.

declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_API_KEY_CMA?: string;
    ANTHROPIC_BASE_URL?: string;
    ENVIRONMENT_ID: string;
    OAUTH_VAULT_KEY: string;
    /**
     * Anthropic model name used by the daily-report cron summarizer.
     * Defaults to `claude-haiku-4-5` when unset.
     */
    DAILY_REPORT_MODEL?: string;
    /**
     * Optional override for the daily-report target date (`YYYY-MM-DD`).
     * When unset the runner computes "yesterday in JST" from the cron tick.
     */
    DAILY_REPORT_DATE?: string;
    /**
     * `"1"` = dry-run mode (do not write the `/<date>.md` memory back).
     */
    DAILY_REPORT_DRY_RUN?: string;
    /**
     * Google Chat Service Account JSON. Same SA the Cloud Run runtime
     * uses for `chat.bot` scope. Provisioned via `wrangler secret put
     * CHAT_SA_KEY_JSON` once per environment.
     *
     * Used by `src/lib/chat-api.ts:postChatMessage` and inbound
     * notification senders (#186 #2 + #4).
     */
    CHAT_SA_KEY_JSON?: string;
    /**
     * Resource name of the Chat space the AgentMail inbound notifier
     * posts to (`spaces/...`). Used by #186 #2 (cold inbound 📨) and
     * #4 (continuation 📤). Leave unset to silence inbound
     * notifications without redeploying.
     */
    MAKOTO_NOTIFY_SPACE?: string;
    /**
     * Initial Chat User OAuth refresh_token (for `chat.messages.readonly`
     * scope, #186 #7). Copied into the KV vault on first use; subsequent
     * Google rotations are persisted to KV. Provisioned via
     * `wrangler secret put GCHAT_OAUTH_REFRESH_TOKEN_SEED`.
     */
    GCHAT_OAUTH_REFRESH_TOKEN_SEED?: string;
    /** Chat User OAuth client_id (Cloud Run side equivalent of `gchat-oauth-token-cma`). */
    GCHAT_OAUTH_CLIENT_ID?: string;
    /** Chat User OAuth client_secret. */
    GCHAT_OAUTH_CLIENT_SECRET?: string;
    /**
     * Google Cloud bot project number (numeric ID as string, e.g.
     * `'192588613210'`). Audience claim that Google Chat embeds in the
     * OIDC JWT it sends to the HTTPS push endpoint
     * (`POST /webhooks/google-chat`). Used by
     * `src/webhooks/google-chat.ts:verifyGoogleChatJwt` to reject tokens
     * minted for a different project.
     *
     * Provisioned via `wrangler secret put GCP_BOT_PROJECT_NUMBER` once
     * per environment.
     */
    GCP_BOT_PROJECT_NUMBER?: string;
    /**
     * Cloudflare Queues binding for inbound Google Chat events
     * (`makoto-chat-queue`). Producer in
     * `src/webhooks/google-chat.ts:handleGoogleChatWebhook`; consumer
     * (Phase B = sessions.create + tool dispatch + marker parse) will be
     * implemented by a follow-up subagent (#186 #5 Phase B).
     */
    MAKOTO_CHAT_QUEUE: Queue<import('../webhooks/google-chat').ChatQueueMessage>;
    /**
     * Google Chat reactive bot displayName (= bot account 表示名)。shared
     * space で `@<displayName>` mention 検知の **displayName-based 簡易**
     * 経路で使う (legacy)。annotations-based 厳密判定では使わない。
     * 未設定なら `MAKOTOくん` を default とする。
     */
    MAKOTO_BOT_DISPLAY_NAME?: string;
    /**
     * Google Chat reactive bot の安定 user 識別子 (= `users/<numeric_id>`)。
     * `Message.annotations` の `userMention.user.name` と一致比較し、
     * `userMention.user.type === 'BOT'` が取れない環境 (= 旧形式 payload や
     * Workspace Add-on 非対応の経路) のフォールバック判定に使う。
     *
     * 一次ソース: `scripts/cma_gchat_bot.py:BOT_USER_NAME` (env
     * `GCHAT_BOT_USER_NAME`)。
     *
     * Used by `src/queue/chat-event-handler.ts` 経由で
     * `src/lib/mention-detection.ts:isMentioningBot`。
     */
    GCHAT_BOT_USER_NAME?: string;
    /**
     * `/costguard` 運用者コマンドの mutation 系 (enable / disable / pause /
     * set / etc.) を実行できる admin email の csv (= Cloud Run 側
     * `COST_GUARD_ADMIN_EMAILS` 等価、Python `cost_guard/command.py:l.33`)。
     * 未設定 = fail-closed (status 閲覧のみ可、mutation 全拒否)。
     *
     * Used by `src/lib/cost-guard-command.ts:handleCostGuardCommand`.
     *
     * Provisioned via `wrangler secret put COST_GUARD_ADMIN_EMAILS`.
     */
    COST_GUARD_ADMIN_EMAILS?: string;
    /** Per-session confirmation thresholds in USD CSV. Default: `8,12,16`. */
    COST_GUARD_SESSION_THRESHOLDS_USD?: string;
    /** USD increment after the last explicit threshold. Default: `4`. */
    COST_GUARD_SESSION_STEP_USD?: string;
    /** Display-only USD→JPY rate for confirmation text. Default: `155`. */
    COST_GUARD_USD_TO_JPY?: string;
    /** Conservative pricing fallback when sessions.retrieve omits model. */
    COST_GUARD_SESSION_PRICING_MODEL?: string;
    /**
     * AgentMail inbox id used by the reactive Chat bot for outbound
     * EMAIL_SEND markers. Cloud Run の `cma-bot` inbox 等価 — 1 つの bot
     * 全体で 1 inbox を共有。未設定だと EMAIL_SEND marker は warn skip
     * される (= deploy 漏れで accidentally メール送信が止まる方を選ぶ)。
     *
     * Provisioned via `wrangler secret put AGENTMAIL_DEFAULT_INBOX_ID`.
    */
    AGENTMAIL_DEFAULT_INBOX_ID?: string;
    /**
     * Anthropic custom Skill for outbound email composition. Deprecated for
     * session routing: existing employee agents must already carry required
     * skills, and #208 no longer creates mail-specific agents/environments.
     */
    MAIL_SEND_SKILL_ID?: string;
    /** Optional pinned version for MAIL_SEND_SKILL_ID. */
    MAIL_SEND_SKILL_VERSION?: string;
    /**
     * GCP project ID hosting Cloud Scheduler jobs (Issue #186
     * SCHEDULE_ACTION dispatch)。`cma-bot-mp-20260501` 既定。未設定だと
     * `chat-event-handler.ts` 側で SCHEDULE_ACTION marker dispatch を
     * **skip** する (= 既存挙動を破壊せず、env 設定で activate)。
     *
     * Provisioned via `wrangler secret put GCP_SCHEDULER_PROJECT` or
     * declared in `wrangler.jsonc` vars.
     */
    GCP_SCHEDULER_PROJECT?: string;
    /**
     * Cloud Scheduler ロケーション (= GCP region)。`asia-northeast1`
     * 既定。未設定だと SCHEDULE_ACTION dispatch を skip する。
     */
    GCP_SCHEDULER_LOCATION?: string;
    /**
     * Scheduler job が publish する Pub/Sub topic。未設定時は既存本番と
     * 同じ単一 topic `cma-scheduled-jobs` を使う。
     */
    SCHEDULER_TOPIC_NAME?: string;
    /**
     * Legacy override: handler 名 → Pub/Sub topic 名 の組み立て prefix。
     * 指定時のみ `<prefix><handler>` で topic 名を生成する。
     */
    SCHEDULER_HANDLER_TOPIC_PREFIX?: string;
    /**
     * Reactive 経路 (chat / mail) の `agent.tool_use` 既定上限 override
     * (整数文字列、1..60 範囲外は WARN + default fallback)。未設定 = 40。
     * Python `_REACTIVE_DEFAULT_MAX_TOOL_CALLS` (`scripts/cma_gchat_bot.py:l.1388`)
     * と等価。`src/lib/cap-recovery.ts:resolveReactiveMaxToolCalls` が読む。
     */
    CMA_REACTIVE_MAX_TOOL_CALLS?: string;
    /**
     * Reactive cap recovery turn の feature flag。"0" / "false" / "no"
     * (大小無視) で無効化。未設定 = 既定有効。Python
     * `_reactive_cap_recovery_enabled` (`scripts/cma_gchat_bot.py:l.1420`)
     * と等価。`src/lib/cap-recovery.ts:isReactiveCapRecoveryEnabled` が読む。
     * scheduled 経路の recovery には影響しない (reactive 専用)。
     */
    CMA_REACTIVE_CAP_RECOVERY_ENABLED?: string;
    /**
     * Reactive Chat session watchdog override in seconds. Unset = 600
     * (Cloud Run parity). Incident tests may set a small value so
     * session_watchdog can be exercised without waiting 10 minutes.
     * Invalid / out-of-range values fail closed to default.
     */
    CMA_REACTIVE_SESSION_WATCHDOG_SEC?: string;
    /**
     * Explicit opt-in for short-lived `user.message` payload audit in
     * Cloudflare KV. Default off. Enable only while observing an incident.
     */
    CMA_AUDIT_USER_MESSAGE_PAYLOADS?: string;
    /** Optional TTL in days for Cloudflare payload audit KV rows. */
    CMA_AUDIT_TTL_DAYS?: string;
    /** Optional max chars per string in Cloudflare payload audit records. */
    CMA_AUDIT_MAX_TEXT_CHARS?: string;
  }
}
