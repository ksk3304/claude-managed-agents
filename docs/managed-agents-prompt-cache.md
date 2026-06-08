# Managed Agents prompt cache notes

Date: 2026-06-08

## User-facing success criteria

Issue #323 is about Claude Console Cache showing prompt cache usage and input-cost reduction.

For this runtime, treat `cache_read_input_tokens > 0` as the success signal. `cache_creation_input_tokens > 0` is only a cache write and does not prove that a later request reused cached tokens.

## Official docs checked

- Anthropic prompt caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Managed Agents session event stream: <https://platform.claude.com/docs/en/managed-agents/events-and-streaming>

Prompt caching docs describe `cache_control` for the Messages API. Managed Agents docs expose cumulative `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`, but do not document a `cache_control` parameter for `sessions.events.send`.

SDK 0.96.0 confirms the same shape:

- `EventSendParams`: `events`, `betas`
- `BetaManagedAgentsUserMessageEventParams`: `type`, `content`

## API probe result

Raw `POST /v1/sessions/{session_id}/events` was tested against a temporary probe agent, then that agent was archived.

Rejected shapes:

- Request body top-level `cache_control`: `400 cache_control: Extra inputs are not permitted`
- `events[0].cache_control`: `400 events.0.cache_control: Extra inputs are not permitted`
- `events[0].content[0].cache_control`: `400 events.0.content.0.cache_control: Extra inputs are not permitted`

Do not add `cache_control` to Managed Agents `user.message` events unless Anthropic changes the API schema. It will break Google Chat replies with 400 responses.

## Runtime logging rule

`cma_prompt_cache_usage` must distinguish writes from reads:

- `prompt_cache_write_observed`: `cache_creation_input_tokens > 0`
- `prompt_cache_read_observed`: `cache_read_input_tokens > 0`
- `prompt_cache_used`: `cache_read_input_tokens > 0`

