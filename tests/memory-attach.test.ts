/**
 * Unit tests for `src/lib/memory-attach.ts` — sender→user_slug→resources.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSenderEmail,
  readUserMapping,
  readUserMappingWithDefault,
  resolveSenderToResources,
} from '../src/lib/memory-attach';
import { makeKv } from './helpers';

describe('normalizeSenderEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeSenderEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });
  it('strips a Display Name <addr> wrapper', () => {
    expect(normalizeSenderEmail('Alice <alice@example.com>')).toBe('alice@example.com');
  });
  it('strips +tag from local part', () => {
    expect(normalizeSenderEmail('alice+work@example.com')).toBe('alice@example.com');
  });
  it('returns lowercased input verbatim when no @ present', () => {
    expect(normalizeSenderEmail('NOTANEMAIL')).toBe('notanemail');
  });
});

describe('readUserMapping / resolveSenderToResources', () => {
  it('returns null when the sender is unknown', async () => {
    const kv = makeKv();
    const result = await resolveSenderToResources(kv, 'stranger@example.com');
    expect(result).toBeNull();
  });

  it('resolves a known sender to user_slug + agent_id + resources', async () => {
    const kv = makeKv();
    await kv.put(
      'user_mapping:alice@example.com',
      JSON.stringify({
        user_slug: 'alice',
        agent_id: 'agent_xxx',
        memory_attachments: [
          { memory_store_id: 'memstore_a', access: 'read_write' },
          { memory_store_id: 'memstore_b', access: 'read_only', instructions: 'note' },
        ],
      }),
    );
    const result = await resolveSenderToResources(kv, 'Alice <ALICE@Example.COM>');
    expect(result).not.toBeNull();
    expect(result!.user_slug).toBe('alice');
    expect(result!.agent_id).toBe('agent_xxx');
    expect(result!.resources).toHaveLength(2);
    expect(result!.resources[0]).toEqual({
      type: 'memory_store',
      memory_store_id: 'memstore_a',
      access: 'read_write',
    });
    // instructions is preserved on the second attachment
    expect(result!.resources[1]).toMatchObject({
      type: 'memory_store',
      memory_store_id: 'memstore_b',
      access: 'read_only',
      instructions: 'note',
    });
    expect(result!.full.space_type).toBe('DM');
    expect(result!.full.filtered_personal_store_count).toBe(0);
  });

  it('normalises the lookup key on +tag and case', async () => {
    const kv = makeKv();
    await kv.put(
      'user_mapping:alice@example.com',
      JSON.stringify({
        user_slug: 'alice',
        agent_id: 'agent_x',
        memory_attachments: [],
      }),
    );
    expect(await readUserMapping(kv, 'ALICE+SUB@example.com')).not.toBeNull();
  });
});

describe('readUserMappingWithDefault (Issue #186 follow-up #8)', () => {
  it('direct hit → isDefault=false (default key untouched)', async () => {
    const kv = makeKv();
    await kv.put(
      'user_mapping:alice@example.com',
      JSON.stringify({
        user_slug: 'alice',
        agent_id: 'agent_a',
        memory_attachments: [],
      }),
    );
    const r = await readUserMappingWithDefault(kv, 'alice@example.com', 'guest');
    expect(r).not.toBeNull();
    expect(r!.isDefault).toBe(false);
    expect(r!.mapping.user_slug).toBe('alice');
  });

  it('miss + defaultSlug set + default mapping exists → isDefault=true', async () => {
    const kv = makeKv();
    await kv.put(
      'user_mapping:guest',
      JSON.stringify({
        user_slug: 'guest',
        agent_id: 'agent_default',
        memory_attachments: [],
      }),
    );
    const r = await readUserMappingWithDefault(kv, 'stranger@example.com', 'guest');
    expect(r).not.toBeNull();
    expect(r!.isDefault).toBe(true);
    expect(r!.mapping.user_slug).toBe('guest');
    expect(r!.mapping.agent_id).toBe('agent_default');
  });

  it('miss + defaultSlug undefined → null (legacy unknown_sender behaviour)', async () => {
    const kv = makeKv();
    const r = await readUserMappingWithDefault(kv, 'stranger@example.com', undefined);
    expect(r).toBeNull();
  });

  it('miss + defaultSlug blank (whitespace) → null (treated as unset)', async () => {
    const kv = makeKv();
    const r = await readUserMappingWithDefault(kv, 'stranger@example.com', '   ');
    expect(r).toBeNull();
  });

  it('miss + defaultSlug set but default mapping absent in KV → null', async () => {
    const kv = makeKv();
    const r = await readUserMappingWithDefault(kv, 'stranger@example.com', 'guest');
    expect(r).toBeNull();
  });
});
