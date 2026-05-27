import { describe, expect, it, vi } from 'vitest';
import {
  auditEnabled,
  recordSessionBind,
  recordRuntimeEvent,
  redactForAudit,
  savePayloadAudit,
  sessionKeyHash,
} from '../src/lib/cma-observability';
import { makeMakotoDb } from './makoto-helpers';

describe('cma-observability', () => {
  it('uses explicit allowlist for payload audit flag', () => {
    expect(auditEnabled('1')).toBe(true);
    expect(auditEnabled('true')).toBe(true);
    expect(auditEnabled('yes')).toBe(true);
    expect(auditEnabled('on')).toBe(true);
    expect(auditEnabled(undefined)).toBe(false);
    expect(auditEnabled('enabled')).toBe(false);
  });

  it('matches Python session key hash shape', async () => {
    const hash = await sessionKeyHash(
      'USER@Example.com',
      'spaces/AAA',
      'spaces/AAA/threads/BBB',
    );
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
    expect(hash).toBe(
      await sessionKeyHash('user@example.com', 'spaces/AAA', 'spaces/AAA/threads/BBB'),
    );
  });

  it('redacts secrets, email, and Google Chat resources', () => {
    const got = redactForAudit({
      text:
        'send sk-ant-abcdefghijklmnop to user@example.com in spaces/AAA/threads/BBB ' +
        'message spaces/AAA/messages/msg_123',
    });
    expect(JSON.stringify(got)).toContain('[REDACTED_TOKEN]');
    expect(JSON.stringify(got)).toContain('[REDACTED_EMAIL]');
    expect(JSON.stringify(got)).toContain('spaces/[REDACTED_SPACE]/threads/[REDACTED_THREAD]');
    expect(JSON.stringify(got)).not.toContain('user@example.com');
    expect(JSON.stringify(got)).not.toContain('spaces/AAA');
  });

  it('records session bind without raw email/thread', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const db = makeMakotoDb();
    const keyHash = await recordSessionBind({
      db,
      senderEmail: 'user@example.com',
      spaceName: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/BBB',
      sessionId: 'sesn_1',
      eventKey: 'chat:event:1',
      messageId: 'spaces/AAA/messages/msg_1',
      userSlug: 'k-seto',
      isNewSession: true,
    });
    expect(keyHash).toMatch(/^[a-f0-9]{12}$/);
    const rows = [...db._tables.cma_session_binds.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe('sesn_1');
    expect(JSON.stringify(rows[0])).not.toContain('user@example.com');
    expect(JSON.stringify(rows[0])).not.toContain('spaces/AAA/threads/BBB');
    const runtimeRows = [...db._tables.cma_worker_runtime_events.values()];
    expect(runtimeRows.some((r) => r.event_type === 'cma_session_bind')).toBe(true);
    log.mockRestore();
  });

  it('saves redacted payload only when explicitly enabled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const db = makeMakotoDb();
    const payload = {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'hello user@example.com sk-ant-abcdefghijklmnop' }],
        },
      ],
    };
    expect(
      await savePayloadAudit({
        db,
        enabledFlag: '0',
        sessionId: 'sesn_1',
        eventKey: 'chat:event:1',
        payload,
      }),
    ).toBe(false);
    expect(db._tables.cma_session_payload_audit.size).toBe(0);
    expect(
      await savePayloadAudit({
        db,
        enabledFlag: '1',
        sessionId: 'sesn_1',
        eventKey: 'chat:event:1',
        messageId: 'spaces/AAA/messages/msg_1',
        userSlug: 'k-seto',
        sessionKeyHash: 'abc123abc123',
        payload,
      }),
    ).toBe(true);
    const rows = [...db._tables.cma_session_payload_audit.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_json).toContain('[REDACTED_EMAIL]');
    expect(rows[0]!.payload_json).toContain('[REDACTED_TOKEN]');
    expect(rows[0]!.payload_json).not.toContain('user@example.com');
    const runtimeRows = [...db._tables.cma_worker_runtime_events.values()];
    expect(runtimeRows.some((r) => r.event_type === 'cma_payload_audit_saved')).toBe(true);
    log.mockRestore();
  });

  it('records redacted runtime events for later Cloudflare-side reads', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const db = makeMakotoDb();
    expect(
      await recordRuntimeEvent({
        db,
        eventKey: 'chat:event:1',
        sessionId: 'sesn_1',
        messageId: 'spaces/AAA/messages/msg_1',
        userSlug: 'k-seto',
        eventType: 'history_fetch_failed',
        level: 'WARN',
        source: 'chat-history',
        detail: {
          error: '403 user@example.com spaces/AAA/threads/BBB sk-ant-abcdefghijklmnop',
        },
      }),
    ).toBe(true);
    const rows = [...db._tables.cma_worker_runtime_events.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('history_fetch_failed');
    expect(rows[0]!.detail_json).toContain('[REDACTED_EMAIL]');
    expect(rows[0]!.detail_json).toContain('[REDACTED_TOKEN]');
    expect(rows[0]!.detail_json).not.toContain('user@example.com');
    log.mockRestore();
  });
});
