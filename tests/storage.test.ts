// Cron-driven pruning behaviour: sent_messages rows older than the cutoff
// must be removed; anything fresher must survive. v4 trims pruneOlderThan
// to sent_messages only (legacy tables are slated for migration 0004).

import { describe, expect, it } from "vitest";
import {
  pruneOlderThan,
  recordSentMessage,
  findSessionByRfc822MessageId,
} from "../src/storage";
import { makeEnv } from "./helpers";

describe("pruneOlderThan", () => {
  it("removes sent_messages older than the cutoff and leaves fresher rows alone", async () => {
    const env = makeEnv();
    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    // Insert through the storage layer so we exercise the same SQL the
    // bridge path runs; then back-date the older row directly on the
    // fake table to drive the cron boundary.
    await recordSentMessage(env.DB, "msg_old", "session_old", "agent_old", "old@example.com", "rfc-old@example.com");
    await recordSentMessage(env.DB, "msg_new", "session_new", "agent_new", "new@example.com", "rfc-new@example.com");
    const oldRow = env.DB._tables.sent_messages.get("msg_old")!;
    oldRow.sent_at_ms = dayAgo;

    const cutoff = now - 24 * 60 * 60 * 1000;
    const result = await pruneOlderThan(env.DB, cutoff);
    expect(result.sentMessages).toBe(1);

    expect(env.DB._tables.sent_messages.has("msg_old")).toBe(false);
    expect(env.DB._tables.sent_messages.has("msg_new")).toBe(true);
  });
});

describe("findSessionByRfc822MessageId", () => {
  it("returns the session + agent for a recorded outbound message", async () => {
    const env = makeEnv();
    await recordSentMessage(env.DB, "msg_1", "session_1", "agent_1", "alice@example.com", "rfc-1@example.com");
    const hit = await findSessionByRfc822MessageId(env.DB, "rfc-1@example.com");
    expect(hit).toEqual({ sessionId: "session_1", agentId: "agent_1" });
  });

  it("records auto_reply_policy for audit", async () => {
    const env = makeEnv();
    await recordSentMessage(
      env.DB,
      "msg_policy",
      "session_1",
      "agent_1",
      "alice@example.com",
      "rfc-policy@example.com",
      "agentmail_auto_reply",
    );
    expect(env.DB._tables.sent_messages.get("msg_policy")?.auto_reply_policy).toBe(
      "agentmail_auto_reply",
    );
  });

  it("normalizes explicit RFC822 ids before storing", async () => {
    const env = makeEnv();
    await recordSentMessage(
      env.DB,
      "msg_explicit",
      "session_1",
      "agent_1",
      "alice@example.com",
      "<OUT-1@Example.COM>",
    );
    expect(env.DB._tables.sent_messages.get("msg_explicit")?.rfc822_msgid).toBe(
      "out-1@example.com",
    );
    await expect(findSessionByRfc822MessageId(env.DB, "out-1@example.com")).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
    });
  });

  it("falls back to RFC822-shaped AgentMail message_id when the explicit field is absent", async () => {
    const env = makeEnv();
    await recordSentMessage(
      env.DB,
      "<0100019e7eb025d0-5aa36622-a034-4379-9e14-869a97ef51c3-000000@email.amazonses.com>",
      "session_1",
      "agent_1",
      "alice@example.com",
    );
    expect(Array.from(env.DB._tables.sent_messages.values())[0]?.rfc822_msgid).toBe(
      "0100019e7eb025d0-5aa36622-a034-4379-9e14-869a97ef51c3-000000@email.amazonses.com",
    );
  });

  it("does not treat opaque AgentMail ids as RFC822 ids", async () => {
    const env = makeEnv();
    await recordSentMessage(env.DB, "msg_out_1", "session_1", "agent_1", "alice@example.com");
    expect(env.DB._tables.sent_messages.get("msg_out_1")?.rfc822_msgid).toBeNull();
  });

  it("returns null when no row matches the message id", async () => {
    const env = makeEnv();
    const miss = await findSessionByRfc822MessageId(env.DB, "never-recorded@example.com");
    expect(miss).toBeNull();
  });
});
