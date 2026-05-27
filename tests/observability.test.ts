import { describe, expect, it } from 'vitest';

import {
  pruneObservability,
  recordChatWebhookPayload,
  recordPayloadAudit,
  recordRuntimeEvent,
  recordSessionBind,
  redactForObservability,
  sessionKeyHash,
} from '../src/lib/observability';
import type { ChatEventPayload } from '../src/webhooks/google-chat';
import { makeMakotoDb } from './makoto-helpers';

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeMakotoDb(),
    ...overrides,
  } as unknown as Env;
}

function chatEvent(): ChatEventPayload {
  return {
    type: 'MESSAGE',
    space: { name: 'spaces/AAA', type: 'ROOM' },
    message: {
      name: 'spaces/AAA/messages/MSG1',
      sender: {
        name: 'users/123',
        email: 'alice@example.com',
      },
      text: 'hello alice@example.com token sk-ant-1234567890abcdef spaces/AAA/threads/TTT',
      thread: { name: 'spaces/AAA/threads/TTT' },
      annotations: [{ type: 'USER_MENTION' }],
      attachment: [{ contentType: 'image/png', name: 'spaces/AAA/attachments/A1' }],
    },
  };
}

describe('observability', () => {
  it('hashes session keys like the Python observer contract', () => {
    expect(sessionKeyHash('alice@example.com', 'spaces/AAA', 'spaces/AAA/threads/TTT')).toBe(
      'd8682dcc86db',
    );
  });

  it('stores webhook allowlist summary without full raw fields', async () => {
    const e = env();
    await recordChatWebhookPayload(e, 'chat:msgname:spaces/AAA/messages/MSG1', chatEvent());
    const table = (e.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables
      .cma_chat_webhook_payloads;
    expect(table).toHaveLength(1);
    expect(table[0]!.text_chars).toBeGreaterThan(0);
    expect(table[0]!.redacted_preview).toContain('[REDACTED_EMAIL]');
    expect(table[0]!.redacted_preview).toContain('[REDACTED_TOKEN]');
    expect(JSON.stringify(table[0])).not.toContain('alice@example.com');
    expect(JSON.stringify(table[0])).not.toContain('spaces/AAA/threads/TTT');
  });

  it('redacts and truncates runtime details', async () => {
    const e = env();
    await recordRuntimeEvent(e, {
      eventKey: 'ev1',
      sessionId: 'sesn_1',
      eventType: 'prompt_envelope_built',
      source: 'test',
      detail: { text: `a@b.com ${'x'.repeat(13_000)}` },
    });
    const row = (e.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables
      .cma_worker_runtime_events[0]!;
    expect(row.detail_json).toContain('[REDACTED_EMAIL]');
    expect(row.detail_json).toContain('[truncated');
    expect(row.detail_chars).toBeGreaterThan(String(row.detail_json).length);
  });

  it('keeps payload audit off by default and writes when explicitly enabled', async () => {
    const offEnv = env();
    await recordPayloadAudit(offEnv, {
      sessionId: 'sesn_1',
      eventKey: 'ev1',
      payload: { user_message: 'secret alice@example.com' },
    });
    expect((offEnv.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables.cma_session_payload_audit).toHaveLength(0);

    const onEnv = env({ CMA_AUDIT_USER_MESSAGE_PAYLOADS: '1' });
    await recordPayloadAudit(onEnv, {
      sessionId: 'sesn_1',
      eventKey: 'ev1',
      payload: { user_message: 'secret alice@example.com' },
    });
    const row = (onEnv.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables
      .cma_session_payload_audit[0]!;
    expect(row.payload_json).toContain('[REDACTED_EMAIL]');
    expect(row.payload_json).not.toContain('alice@example.com');
  });

  it('records session bind and prunes expired observability rows', async () => {
    const e = env();
    await recordSessionBind(e, {
      senderEmail: 'alice@example.com',
      spaceName: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/TTT',
      sessionId: 'sesn_1',
      eventKey: 'ev1',
      isNewSession: true,
    });
    const tables = (e.DB as unknown as ReturnType<typeof makeMakotoDb>)._tables;
    expect(tables.cma_session_binds[0]!.session_key_hash).toBe('d8682dcc86db');
    tables.cma_session_binds[0]!.expire_at_ms = 1;
    const result = await pruneObservability(e, 2);
    expect(result.sessionBinds).toBe(1);
    expect(tables.cma_session_binds).toHaveLength(0);
  });

  it('redacts nested payload values', () => {
    expect(redactForObservability({ t: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toEqual({
      t: '[REDACTED_TOKEN]',
    });
  });
});
