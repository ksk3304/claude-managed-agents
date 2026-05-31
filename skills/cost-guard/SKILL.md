---
name: cost-guard
description: Use when a Google Chat user asks MAKOTOくん about Cost Guard, budget guardrails, safety device status, monthly USD/call limits, chat post limits, external API limits, or asks to pause, resume, enable, disable, or change those limits. Also match Japanese natural language such as コストガード, 安全装置, 予算ガード, 月額上限, 投稿数上限, 外部API上限, and the voice typo ポストカード.
---

# Cost Guard

You help MAKOTOくん recognize and handle Cost Guard requests from Google Chat.

Cost Guard is the runtime safety layer that reports and controls budget-related guardrails:

- Anthropic API monthly call limit.
- Anthropic monthly USD limit.
- Chat daily post limit.
- External API daily call limit.
- Temporary pause / resume / enable / disable.

## Trigger Phrases

Treat these as Cost Guard requests:

- `コストガード見せて`
- `コストガードどうなってる？`
- `安全装置どうなってる？`
- `予算ガード確認`
- `ポストカードの状態`
- `安全装置を10分止めて`
- `コストガード再開して`
- `月額上限を100ドルにして`
- `Chat投稿数上限を50に変更`
- `外部API上限を20にして`

## Routing Rules

- Do not answer Cost Guard status from memory or guess current counters.
- Status and mutation requests must be handled by the host application's deterministic Cost Guard handler.
- Slash commands such as `/costguard status` are allowed, but users do not need to know them.
- Prefer natural-language recognition. A single keyword such as `コストガード`, `安全装置`, or `ポストカード` can be enough when the surrounding message asks for status.

## Permission Rules

- Status/read-only requests may be answered for normal Chat users if the host handler allows it.
- Mutations are admin-only.
- Dangerous mutations must not be treated as complete until the host handler confirms them.
- If the host handler reports a confirmation token, tell the user the exact confirmation step it returned.
- If the user is not an admin, do not suggest bypasses.

## Mutation Mapping

Map natural language to the host operation:

- `再開`, `復帰`, `戻して`, `解除` -> resume.
- `有効化`, `有効に`, `オンに` -> enable.
- `一時停止`, `10分止めて`, `1時間止めて` -> pause with duration.
- `無効化`, `無効に`, `オフに`, duration-free `止めて` -> disable.
- `月額上限`, `予算`, `USD`, `ドル` + number -> set monthly USD hard cap.
- `呼び数`, `呼び出し数`, `calls` + number -> set monthly Anthropic call hard cap.
- `Chat投稿数`, `投稿数` + number -> set daily Chat post hard cap.
- `外部API`, `external API` + number -> set daily external API hard cap.

## Fallback

If a Cost Guard request reaches you without a host handler result, respond briefly that the Cost Guard handler did not run and ask the user to retry with a natural phrase such as `コストガード見せて` or `安全装置を10分止めて`.
