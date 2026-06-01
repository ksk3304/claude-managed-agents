import { describe, expect, it } from 'vitest';
import { saveUserMessagePayloadAudit } from '../src/lib/payload-audit';
import { makeKv } from './helpers';

describe('saveUserMessagePayloadAudit', () => {
  it('does nothing unless explicitly enabled', async () => {
    const kv = makeKv();
    const saved = await saveUserMessagePayloadAudit(
      'sesn_off',
      [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
      { kv, enabled: '0', mode: 'chat' },
    );

    expect(saved).toBe(false);
    const listed = await kv.list({ prefix: 'cma_payload_audit:' });
    expect(listed.keys).toHaveLength(0);
  });

  it('stores redacted user.message payload with a short TTL', async () => {
    const kv = makeKv();
    const saved = await saveUserMessagePayloadAudit(
      'sesn_on',
      [
        {
          type: 'user.message',
          content: [
            {
              type: 'text',
              text:
                'from alice@example.com token sk-ant-1234567890abcdef ' +
                'thread spaces/AAA/threads/TH1',
            },
          ],
        },
      ],
      {
        kv,
        enabled: '1',
        ttlDays: '2',
        maxTextChars: '2000',
        mode: 'chat',
        context: {
          sender_email: 'alice@example.com',
          space_name: 'spaces/AAA',
        },
      },
    );

    expect(saved).toBe(true);
    const listed = await kv.list({ prefix: 'cma_payload_audit:sesn_on:' });
    expect(listed.keys).toHaveLength(1);
    const raw = await kv.get(listed.keys[0]!.name);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!);
    const text = JSON.stringify(record);
    expect(record.mode).toBe('chat');
    expect(record.ttl_days).toBe(2);
    expect(text).toContain('alice@example.com');
    expect(text).toContain('[REDACTED_TOKEN]');
    expect(text).toContain('spaces/[REDACTED_SPACE]/threads/[REDACTED_THREAD]');
    expect(text).not.toContain('sk-ant-1234567890abcdef');
  });
});
