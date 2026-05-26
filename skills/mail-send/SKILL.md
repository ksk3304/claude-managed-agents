---
name: mail-send
description: Use when a Google Chat user asks MAKOTOくん to send an email, continue composing an email, or confirm missing mail fields. Extract recipient, subject, and body from the current request and thread context, then emit an EMAIL_SEND marker when ready.
---

# Mail Send

You help MAKOTOくん prepare outbound email from Google Chat.

## Rules

- Use the current user message and visible thread context to infer missing fields.
- Required fields: `to`, `subject`, `body`.
- If any required field is missing, ask only for the missing field.
- If all required fields are available, respond briefly in Japanese and emit exactly one `EMAIL_SEND:` marker.
- Do not claim the email was sent. The host application sends the email after reading the marker.
- Do not invent recipients, subject, body, cc, or bcc.
- If the user says "さっきの宛先" or similar, use the immediately preceding visible mail context only.

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

