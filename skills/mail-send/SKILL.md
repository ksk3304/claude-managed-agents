---
name: mail-send
description: Use when a Google Chat user asks MAKOTOくん to send an email, continue composing an email, or confirm missing mail fields. Extract recipient, subject, and body from the current request and thread context, then emit an EMAIL_SEND marker when ready.
---

# Mail Send

You help MAKOTOくん prepare outbound email from Google Chat.

## Rules

- Use the current user message and visible thread context to infer missing fields.
- Required fields for actual send: `to`, `subject`, `body`.
- If `to` and a clear topic or subject are available but `body` is not, you MUST draft a concise body and ask for confirmation instead of asking the user to write the body from scratch.
- Do not say "本文が分からないので教えてください" when a topic is available. A topic such as "猫の行動について" is enough to draft a short neutral body.
- When asking for confirmation, show `to`, `subject`, and drafted `body`, then ask if it should be sent as-is.
- If the user confirms a draft, emit exactly one `EMAIL_SEND:` marker using the confirmed fields.
- If all required fields are explicitly available in the user's request, respond briefly in Japanese and emit exactly one `EMAIL_SEND:` marker.
- Do not claim the email was sent. The host application sends the email after reading the marker.
- Do not invent recipients, cc, or bcc.
- You may draft a body from an explicit topic such as "猫の行動について" or "明日のMTGについて"; keep it short and neutral.
- If the user says "さっきの宛先" or similar, use the immediately preceding visible mail context only.

## Confirmation Example

User:

```text
k.seto@makotoprime.com に猫の行動についてのメールして
```

Assistant:

```text
以下の内容で送ってよいですか？

宛先: k.seto@makotoprime.com
件名: 猫の行動について
本文:
猫の行動について、簡単にまとめます。

猫は高い場所を好む、ゆっくり瞬きをする、喉を鳴らすなど、安心感や信頼を示す行動をよく見せます。一方で、しっぽの動きや耳の向きには警戒・不安が表れることもあります。

必要であれば、もう少し詳しい内容に調整できます。
```

## Marker Format

Emit the marker as one line:

```text
EMAIL_SEND:{"to":"user@example.com","subject":"件名","body":"本文"}
```

Optional fields may be included when explicitly provided:

```text
EMAIL_SEND:{"to":"user@example.com","cc":["cc@example.com"],"bcc":["bcc@example.com"],"subject":"件名","body":"本文"}
```

JSON must be valid and compact. Escape newlines inside `body` as `\n`.
