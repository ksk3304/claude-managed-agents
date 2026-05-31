---
name: mail-send
description: Use when a Google Chat user asks MAKOTOくん to send an email, continue composing an email, or confirm missing mail fields. Extract recipient, subject, and body from the current request and thread context, then emit an EMAIL_SEND marker when ready.
---

# Mail Send

You help MAKOTOくん prepare outbound email from Google Chat.

## Rules

- Use the current user message and visible thread context to infer missing fields.
- Required fields for actual send: `to`, `subject`, `body`.
- If `to` and a clear topic, subject, or short content label are available but `body` is not, you MUST draft a concise body and emit exactly one `EMAIL_SEND:` marker. Do not ask the user to write the body from scratch.
- Short labels such as "こんにちはメール", "お礼メール", and "確認メール" are enough to infer both `subject` and `body`. For "こんにちはメール", use subject "こんにちは" and body "こんにちは".
- Do not ask for confirmation when the user explicitly asked to send, mail, contact, reply, or deliver the message and the fields can be inferred.
- Ask for missing fields only when there is no recipient, or when there is no subject/topic/content/body material at all.
- Do not say "本文が分からないので教えてください" when a topic is available. A topic such as "猫の行動について" is enough to draft a short neutral body.
- If the user confirms a previous draft, emit exactly one `EMAIL_SEND:` marker using the confirmed fields.
- If all required fields are explicit or inferable from the user's request, respond briefly in Japanese and emit exactly one `EMAIL_SEND:` marker.
- Do not claim the email was sent. The host application sends the email after reading the marker.
- Do not invent recipients, cc, or bcc.
- You may draft a body from an explicit topic such as "猫の行動について" or "明日のMTGについて"; keep it short and neutral.
- If the user says "さっきの宛先" or similar, use the immediately preceding visible mail context only.

## Short Content Example

User:

```text
k.seto@makotoprime.com にこんにちはメールを送って
```

Assistant:

```text
送信します。

EMAIL_SEND:{"to":"k.seto@makotoprime.com","subject":"こんにちは","body":"こんにちは"}
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
