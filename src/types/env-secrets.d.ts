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
     * space で `@<displayName>` mention 検知に使う。未設定なら
     * `MAKOTOくん` を default とする。
     *
     * Used by `src/queue/chat-event-handler.ts:textMentionsBot`.
     */
    MAKOTO_BOT_DISPLAY_NAME?: string;
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
     * handler 名 → Pub/Sub topic 名 の組み立て prefix。`cma-scheduler-`
     * 既定。`<prefix><handler>` で topic 名を生成する (= Cloud Run 側の
     * 単一 topic `cma-scheduled-jobs` モデルとは別に、Cloudflare 側は
     * handler 別 topic モデルで分けて運用する)。
     */
    SCHEDULER_HANDLER_TOPIC_PREFIX?: string;
  }
}
