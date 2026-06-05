/**
 * Unit tests for `src/lib/session-log.ts` — Cloud Run の
 * `_append_session_log_memory` / `_session_log_entry` / `_session_log_base_path`
 * / `_slug_for_memory_path` 等の TS port が byte 等価で動くことを担保する.
 *
 * Pure helper (slug / path / entry) と SDK-driven (`appendSessionLogMemory`)
 * の 2 群に分け、後者は `Anthropic` SDK 互換の mock を注入する.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_LOG_MAX_BYTES,
  appendSessionLogMemory,
  buildSessionLogEntry,
  extractMemoryItemContent,
  isSharedSpace,
  sanitizeInlineValue,
  selectSessionLogAttachment,
  sessionLogBasePath,
  slugForMemoryPath,
  slugFromEmail,
} from '../src/lib/session-log';
import type { AppendSessionLogDeps } from '../src/lib/session-log';
import type { MemoryAttachment } from '../src/types/memory';

// ============================================================================
// Pure helpers
// ============================================================================

describe('isSharedSpace', () => {
  it('returns false for DM / DIRECT_MESSAGE (case insensitive)', () => {
    expect(isSharedSpace('DM')).toBe(false);
    expect(isSharedSpace('dm')).toBe(false);
    expect(isSharedSpace('DIRECT_MESSAGE')).toBe(false);
    expect(isSharedSpace('direct_message')).toBe(false);
  });
  it('returns true for ROOM / GROUP_CHAT / SPACE / unknown', () => {
    expect(isSharedSpace('ROOM')).toBe(true);
    expect(isSharedSpace('GROUP_CHAT')).toBe(true);
    expect(isSharedSpace('SPACE')).toBe(true);
    expect(isSharedSpace('UNKNOWN')).toBe(true);
    expect(isSharedSpace('')).toBe(true);
    expect(isSharedSpace(null)).toBe(true);
    expect(isSharedSpace(undefined)).toBe(true);
  });
});

describe('slugFromEmail', () => {
  it('replaces `.` with `-` and lowercases the local part only', () => {
    expect(slugFromEmail('Keisuke.Seto@example.com')).toBe('keisuke-seto');
  });
  it('returns the full lowercase string when no @ is present', () => {
    expect(slugFromEmail('NoAtHere')).toBe('noathere');
  });
  it('handles dotless local parts', () => {
    expect(slugFromEmail('alice@example.com')).toBe('alice');
  });
});

describe('sanitizeInlineValue', () => {
  it('collapses runs of whitespace into a single space and trims', () => {
    expect(sanitizeInlineValue('  a   b\nc\t\td  ')).toBe('a b c d');
  });
  it('replaces control / format characters with space', () => {
    // U+0001 (Cc, START OF HEADING) is a control character.
    expect(sanitizeInlineValue('foobar')).toBe('foo bar');
  });
  it('returns empty string for null / undefined / empty', () => {
    expect(sanitizeInlineValue('')).toBe('');
    expect(sanitizeInlineValue(null)).toBe('');
    expect(sanitizeInlineValue(undefined)).toBe('');
  });
  it('does not strip ordinary content', () => {
    expect(sanitizeInlineValue('MAKOTOくん 議事録')).toBe('MAKOTOくん 議事録');
  });
});

describe('slugForMemoryPath', () => {
  it('NFKC-normalizes and lowercases ASCII content', async () => {
    expect(await slugForMemoryPath('Hello World', 'seed')).toBe('hello-world');
  });
  it('collapses runs of non-alphanum into a single dash and strips edges', async () => {
    expect(await slugForMemoryPath('  Foo!!Bar  ', 'seed')).toBe('foo-bar');
  });
  it('truncates to 80 characters', async () => {
    const long = 'a'.repeat(200);
    const slug = await slugForMemoryPath(long, 'seed');
    expect(slug.length).toBe(80);
    expect(slug).toBe('a'.repeat(80));
  });
  it('falls back to `space-<8hex>` for non-ASCII-only input (no surviving alphanum)', async () => {
    const slug = await slugForMemoryPath('議事録', 'seed-A');
    expect(slug).toMatch(/^space-[0-9a-f]{8}$/);
  });
  it('fallback hash is deterministic for the same seed', async () => {
    const a = await slugForMemoryPath('🌸', 'shared-1');
    const b = await slugForMemoryPath('日本語', 'shared-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^space-[0-9a-f]{8}$/);
  });
  it('fallback hash differs for different seeds', async () => {
    const a = await slugForMemoryPath('', 'seed-A');
    const b = await slugForMemoryPath('', 'seed-B');
    expect(a).not.toBe(b);
  });
  it('NFKC normalizes full-width digits', async () => {
    // U+FF11 (FULLWIDTH DIGIT ONE) → '1' under NFKC.
    expect(await slugForMemoryPath('Room１', 'seed')).toBe('room1');
  });
});

// ============================================================================
// sessionLogBasePath
// ============================================================================

describe('sessionLogBasePath', () => {
  it('shared: alias is transport metadata and does not split owner-agent log path', async () => {
    const path = await sessionLogBasePath({
      dateLabel: '2026-05-26',
      spaceType: 'ROOM',
      userSlug: 'keisuke-seto',
      senderEmail: 'k.seto@makotoprime.com',
      space: { name: 'spaces/AAA', displayName: 'プロジェクト IT 開発', type: 'ROOM' },
      sender: { name: 'users/u1', email: 'k.seto@makotoprime.com' },
      reverseResolveAlias: (sid) => (sid === 'spaces/AAA' ? 'it-dev' : null),
    });
    expect(path).toBe('/2026/05/26');
  });
  it('shared: displayName is transport metadata and does not split owner-agent log path', async () => {
    const path = await sessionLogBasePath({
      dateLabel: '2026-05-26',
      spaceType: 'ROOM',
      userSlug: 'keisuke-seto',
      senderEmail: 'k.seto@makotoprime.com',
      space: { name: 'spaces/BBB', displayName: 'Daily Standup', type: 'ROOM' },
      sender: { name: 'users/u1' },
    });
    expect(path).toBe('/2026/05/26');
  });
  it('shared: space.name is transport metadata and does not split owner-agent log path', async () => {
    const path = await sessionLogBasePath({
      dateLabel: '2026-05-26',
      spaceType: 'ROOM',
      userSlug: 'keisuke-seto',
      senderEmail: 'k.seto@makotoprime.com',
      space: { name: 'spaces/XYZ-123', type: 'ROOM' },
      sender: {},
    });
    expect(path).toBe('/2026/05/26');
  });
  it('uses `/YYYY/MM/DD` for DM and shared spaces', async () => {
    const path = await sessionLogBasePath({
      dateLabel: '2026-05-26',
      spaceType: 'DM',
      userSlug: 'keisuke-seto',
      senderEmail: 'k.seto@makotoprime.com',
      space: { name: 'spaces/DM1', type: 'DM' },
      sender: { name: 'users/u1', email: 'k.seto@makotoprime.com' },
    });
    expect(path).toBe('/2026/05/26');
  });
  it('ignores non ASCII user_slug because store is already owner-scoped', async () => {
    const path = await sessionLogBasePath({
      dateLabel: '2026-05-26',
      spaceType: 'DM',
      userSlug: '日本語スラッグ',
      senderEmail: 'who@example.com',
      space: { type: 'DM' },
      sender: { name: 'users/u9' },
    });
    expect(path).toBe('/2026/05/26');
  });
});

// ============================================================================
// buildSessionLogEntry
// ============================================================================

describe('buildSessionLogEntry', () => {
  it('produces a markdown entry with byte-equivalent header structure', () => {
    const entry = buildSessionLogEntry({
      eventTime: '2026-05-26T10:30:00+09:00',
      space: { name: 'spaces/AAA', type: 'ROOM' },
      sender: { name: 'users/u1', email: 'keisuke.seto@example.com' },
      threadName: 'spaces/AAA/threads/t1',
      userText: 'こんにちは',
      finalText: 'はい、承知しました',
      sessionId: 'sess_123',
      messageId: 'msg_456',
    });
    expect(entry).toBe(
      `\n---\n` +
        `## 2026-05-26T10:30:00+09:00 keisuke-seto\n\n` +
        `- space_type: ROOM\n` +
        `- space: spaces/AAA\n` +
        `- thread: spaces/AAA/threads/t1\n` +
        `- session_id: sess_123\n` +
        `- message_id: msg_456\n\n` +
        `### User\n\n` +
        `こんにちは\n\n` +
        `### Agent\n\n` +
        `はい、承知しました\n`,
    );
  });
  it('uses `(no-thread)` / `(no-space)` / `n/a` placeholders for empty fields', () => {
    const entry = buildSessionLogEntry({
      eventTime: '2026-05-26T00:00:00+09:00',
      space: {},
      sender: { email: 'a@b.com' },
      threadName: null,
      userText: '',
      finalText: '',
    });
    expect(entry).toContain('- space_type: UNKNOWN\n');
    expect(entry).toContain('- space: (no-space)\n');
    expect(entry).toContain('- thread: (no-thread)\n');
    expect(entry).toContain('- session_id: n/a\n');
    expect(entry).toContain('- message_id: n/a\n');
    expect(entry).toContain('### User\n\n（空）\n\n');
    expect(entry).toContain('### Agent\n\n（空）\n');
  });
  it('sanitizes inline control chars in thread / space / ids', () => {
    const entry = buildSessionLogEntry({
      eventTime: '2026-05-26T00:00:00+09:00',
      space: { name: 'spaces/X\nINJECT', type: 'ROOM' },
      sender: { email: 'a@b.com' },
      threadName: 'threadname',
      userText: 'u',
      finalText: 'f',
      sessionId: 'sess\nbreak',
      messageId: 'msg id with    spaces',
    });
    expect(entry).toContain('- space: spaces/X INJECT\n');
    expect(entry).toContain('- thread: thread name\n');
    expect(entry).toContain('- session_id: sess break\n');
    expect(entry).toContain('- message_id: msg id with spaces\n');
  });
  it('falls back to sender.name when sender.email is missing', () => {
    const entry = buildSessionLogEntry({
      eventTime: '2026-05-26T00:00:00+09:00',
      space: {},
      sender: { name: 'Alice.Bob@example.com' },
      userText: 'x',
      finalText: 'y',
    });
    expect(entry).toContain('## 2026-05-26T00:00:00+09:00 alice-bob\n');
  });
  it('uses space.spaceType when space.type is missing', () => {
    const entry = buildSessionLogEntry({
      eventTime: '2026-05-26T00:00:00+09:00',
      space: { spaceType: 'GROUP_CHAT' },
      sender: { email: 'a@b.com' },
      userText: 'x',
      finalText: 'y',
    });
    expect(entry).toContain('- space_type: GROUP_CHAT\n');
  });
});

// ============================================================================
// selectSessionLogAttachment
// ============================================================================

describe('selectSessionLogAttachment', () => {
  const unifiedAtt: MemoryAttachment = {
    memory_store_id: 'memstore_unified',
    access: 'read_write',
    store_name: 'session_log',
    instructions: 'agent 番号単位のセッションログ',
  };
  const sharedAtt: MemoryAttachment = {
    memory_store_id: 'memstore_shared',
    access: 'read_write',
    store_name: 'session_log_shared_store',
    instructions: '共有スペースのセッションログを記録',
  };
  const dmAtt: MemoryAttachment = {
    memory_store_id: 'memstore_dm',
    access: 'read_write',
    store_name: 'session_log_dm_store',
    instructions: 'DM (個人 1:1) のセッションログを記録',
  };
  const numberedAtt: MemoryAttachment = {
    memory_store_id: 'memstore_makoto_prime_0001_log',
    access: 'read_write',
    store_name: 'Makoto Prime_0001_session_log_store',
    instructions: 'Makoto Prime 0001 セッションログを記録',
  };
  const otherAtt: MemoryAttachment = {
    memory_store_id: 'memstore_other',
    access: 'read_only',
    store_name: 'persona_memory',
  };

  it('selects unified session_log store for shared spaces', () => {
    const att = selectSessionLogAttachment('ROOM', [otherAtt, unifiedAtt, sharedAtt, dmAtt]);
    expect(att?.memory_store_id).toBe('memstore_unified');
  });
  it('selects unified session_log store for DM space', () => {
    const att = selectSessionLogAttachment('DM', [otherAtt, unifiedAtt, sharedAtt, dmAtt]);
    expect(att?.memory_store_id).toBe('memstore_unified');
  });
  it('falls back to legacy shared/dm stores when unified store is absent', () => {
    expect(selectSessionLogAttachment('ROOM', [otherAtt, sharedAtt, dmAtt])?.memory_store_id).toBe(
      'memstore_shared',
    );
    expect(selectSessionLogAttachment('DM', [otherAtt, sharedAtt, dmAtt])?.memory_store_id).toBe(
      'memstore_dm',
    );
  });
  it('returns null when no candidate is present', () => {
    expect(selectSessionLogAttachment('ROOM', [otherAtt])).toBeNull();
    expect(selectSessionLogAttachment('DM', [otherAtt])).toBeNull();
    expect(selectSessionLogAttachment('ROOM', [])).toBeNull();
  });
  it('falls back to instructions match when store_name is missing (legacy)', () => {
    const legacyShared: MemoryAttachment = {
      memory_store_id: 'memstore_legacy_shared',
      access: 'read_write',
      instructions: '共有スペースのセッションログ',
    };
    const legacyDm: MemoryAttachment = {
      memory_store_id: 'memstore_legacy_dm',
      access: 'read_write',
      instructions: 'DM (個人 1:1) のセッションログ',
    };
    expect(
      selectSessionLogAttachment('ROOM', [legacyShared, legacyDm])?.memory_store_id,
    ).toBe('memstore_legacy_dm');
    expect(
      selectSessionLogAttachment('DM', [legacyShared, legacyDm])?.memory_store_id,
    ).toBe('memstore_legacy_dm');
  });
});

// ============================================================================
// extractMemoryItemContent
// ============================================================================

describe('extractMemoryItemContent', () => {
  it('returns string content as-is', () => {
    expect(extractMemoryItemContent('hello')).toBe('hello');
  });
  it('joins list of strings with newline', () => {
    expect(extractMemoryItemContent(['a', 'b', 'c'])).toBe('a\nb\nc');
  });
  it('joins list of blocks via .text', () => {
    expect(extractMemoryItemContent([{ text: 'a' }, { text: 'b' }])).toBe('a\nb');
  });
  it('returns empty string for null / unknown shapes', () => {
    expect(extractMemoryItemContent(null)).toBe('');
    expect(extractMemoryItemContent(undefined)).toBe('');
    expect(extractMemoryItemContent(42)).toBe('');
  });
});

// ============================================================================
// appendSessionLogMemory — SDK-driven flow with mock client
// ============================================================================

interface MemoryItem {
  type: 'memory';
  id: string;
  path: string;
  content: string;
  content_sha256: string;
}

/**
 * In-memory Anthropic SDK shim. Models exactly the surface
 * `appendSessionLogMemory` uses: `beta.memoryStores.memories.{list, retrieve,
 * create, update}`. We do not aim for full SDK compatibility — only the
 * field shapes the lib reads.
 */
function makeMockClient(initial: MemoryItem[] = []) {
  const store = new Map<string, MemoryItem>();
  for (const m of initial) store.set(m.path, { ...m });

  const calls = {
    list: 0,
    retrieve: 0,
    create: 0,
    update: 0,
  };
  let nextId = 1;

  const memories = {
    list(_memoryStoreId: string) {
      calls.list += 1;
      const snapshot = Array.from(store.values()).map((m) => ({ ...m }));
      return Promise.resolve({
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next() {
              if (i < snapshot.length) {
                return Promise.resolve({ value: snapshot[i++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });
    },
    retrieve(memoryId: string, _params: { memory_store_id: string }) {
      calls.retrieve += 1;
      for (const m of store.values()) {
        if (m.id === memoryId) return Promise.resolve({ ...m });
      }
      return Promise.reject(new Error(`memory not found: ${memoryId}`));
    },
    create(
      memoryStoreId: string,
      params: { content: string; path: string },
    ) {
      calls.create += 1;
      if (store.has(params.path)) {
        return Promise.reject(new Error(`path conflict: ${params.path}`));
      }
      const id = `mem_${nextId++}`;
      const item: MemoryItem = {
        type: 'memory',
        id,
        path: params.path,
        content: params.content,
        content_sha256: 'fake-sha',
      };
      store.set(params.path, item);
      void memoryStoreId;
      return Promise.resolve({ ...item });
    },
    update(
      memoryId: string,
      params: { memory_store_id: string; content?: string | null },
    ) {
      calls.update += 1;
      for (const m of store.values()) {
        if (m.id === memoryId) {
          if (params.content !== undefined && params.content !== null) {
            m.content = params.content;
          }
          return Promise.resolve({ ...m });
        }
      }
      return Promise.reject(new Error(`memory not found: ${memoryId}`));
    },
  };

  const client = {
    beta: {
      memoryStores: {
        memories,
      },
    },
  };

  return { client, store, calls };
}

const SHARED_ATTACHMENT: MemoryAttachment = {
  memory_store_id: 'memstore_shared',
  access: 'read_write',
  store_name: 'session_log',
  instructions: 'agent 番号単位のセッションログ',
};
const DM_ATTACHMENT: MemoryAttachment = {
  memory_store_id: 'memstore_dm',
  access: 'read_write',
  store_name: 'session_log',
  instructions: 'agent 番号単位のセッションログ',
};
const NUMBERED_ATTACHMENT: MemoryAttachment = {
  memory_store_id: 'memstore_makoto_prime_0001_log',
  access: 'read_write',
  store_name: 'Makoto Prime_0001_session_log_store',
  instructions: 'Makoto Prime 0001 セッションログ',
};

const FIXED_NOW = new Date('2026-05-26T01:30:00.000Z'); // = 2026-05-26 10:30:00 JST.

function deps(overrides: Partial<AppendSessionLogDeps> & { client: unknown }): AppendSessionLogDeps {
  return {
    now: () => FIXED_NOW,
    ...overrides,
  } as AppendSessionLogDeps;
}

describe('appendSessionLogMemory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns appended=false when no matching attachment is present', async () => {
    const mock = makeMockClient();
    const result = await appendSessionLogMemory(
      deps({ client: mock.client }),
      {
        senderEmail: 'a@b.com',
        spaceType: 'ROOM',
        userSlug: 'a',
        memoryAttachments: [], // no shared store
        space: { name: 'spaces/x', displayName: 'X', type: 'ROOM' },
        sender: { email: 'a@b.com' },
        userText: 'u',
        finalText: 'f',
      },
    );
    expect(result.appended).toBe(false);
    expect(mock.calls.list).toBe(0);
    expect(mock.calls.create).toBe(0);
  });

  it('creates a new memory when none exists at the owner-agent target path', async () => {
    const mock = makeMockClient();
    const result = await appendSessionLogMemory(
      deps({
        client: mock.client,
        reverseResolveAlias: (sid) => (sid === 'spaces/AAA' ? 'it-dev' : null),
      }),
      {
        senderEmail: 'k.seto@makotoprime.com',
        spaceType: 'ROOM',
        userSlug: 'keisuke-seto',
        memoryAttachments: [SHARED_ATTACHMENT, DM_ATTACHMENT, NUMBERED_ATTACHMENT],
        space: { name: 'spaces/AAA', displayName: 'IT Dev', type: 'ROOM' },
        sender: { name: 'users/u1', email: 'k.seto@makotoprime.com' },
        userText: 'はじめまして',
        finalText: 'よろしくお願いします',
        sessionId: 'sess_42',
      },
    );
    expect(result.appended).toBe(true);
    expect(result.action).toBe('create');
    expect(result.path).toBe('/2026/05/26.md');
    expect(result.suffix).toBe(1);
    expect(mock.calls.create).toBe(1);
    expect(mock.calls.update).toBe(0);
    expect(mock.calls.retrieve).toBe(0);

    const written = mock.store.get('/2026/05/26.md');
    expect(written).toBeDefined();
    expect(written?.content).toContain('## 2026-05-26T10:30:00+09:00 k-seto\n');
    expect(written?.content).toContain('- session_id: sess_42\n');
    expect(written?.content).toContain('### User\n\nはじめまして\n');
    expect(written?.content).toContain('### Agent\n\nよろしくお願いします\n');
    // lstrip applied on new memory (no leading `\n---\n` after lstrip).
    expect(written?.content.startsWith('---\n')).toBe(true);
  });

  it('updates an existing memory by appending the new entry (DM)', async () => {
    const existing: MemoryItem = {
      type: 'memory',
      id: 'mem_existing',
      path: '/2026/05/26.md',
      content: '---\n## 既存エントリ\n\n旧本文\n',
      content_sha256: 'old-sha',
    };
    const mock = makeMockClient([existing]);
    const result = await appendSessionLogMemory(
      deps({ client: mock.client }),
      {
        senderEmail: 'k.seto@makotoprime.com',
        spaceType: 'DM',
        userSlug: 'keisuke-seto',
        memoryAttachments: [DM_ATTACHMENT, SHARED_ATTACHMENT],
        space: { name: 'spaces/DM1', type: 'DM' },
        sender: { name: 'users/u1', email: 'k.seto@makotoprime.com' },
        userText: '追記する',
        finalText: '追記しました',
      },
    );
    expect(result.appended).toBe(true);
    expect(result.action).toBe('update');
    expect(result.path).toBe('/2026/05/26.md');
    expect(result.suffix).toBe(1);
    expect(mock.calls.update).toBe(1);
    expect(mock.calls.create).toBe(0);
    expect(mock.calls.retrieve).toBe(1);

    const written = mock.store.get('/2026/05/26.md');
    expect(written?.content).toContain('## 既存エントリ');
    expect(written?.content).toContain('### User\n\n追記する');
    expect(written?.content).toContain('### Agent\n\n追記しました');
    // The append concatenates with one `\n` between old (rstrip-ed) and entry,
    // and lstrip is applied to the whole. The entry itself starts with `\n---\n`
    // → rstrip(old) + "\n" + "\n---\n..." = "旧本文\n\n---\n...".
    expect(written?.content).toMatch(/旧本文\n\n---\n## 2026-05-26T10:30:00\+09:00/);
  });

  it('advances the suffix when the appended content would exceed max_bytes', async () => {
    // Fill the first file to within a few bytes of the cap so any append overflows.
    const cap = 1024; // use a small cap for the test
    const filler = 'x'.repeat(cap - 5);
    const existingFirst: MemoryItem = {
      type: 'memory',
      id: 'mem_first',
      path: '/2026/05/26.md',
      content: filler,
      content_sha256: 'sha-first',
    };
    const mock = makeMockClient([existingFirst]);
    const result = await appendSessionLogMemory(
      deps({ client: mock.client, maxBytes: cap }),
      {
        senderEmail: 'k.seto@makotoprime.com',
        spaceType: 'DM',
        userSlug: 'keisuke-seto',
        memoryAttachments: [DM_ATTACHMENT],
        space: { name: 'spaces/DM1', type: 'DM' },
        sender: { name: 'users/u1', email: 'k.seto@makotoprime.com' },
        userText: 'u',
        finalText: 'f',
      },
    );
    expect(result.appended).toBe(true);
    expect(result.action).toBe('create');
    expect(result.suffix).toBe(2);
    expect(result.path).toBe('/2026/05/26-2.md');
    // The first file is untouched (still the filler).
    expect(mock.store.get('/2026/05/26.md')?.content).toBe(filler);
    // The -2.md file was created.
    expect(mock.store.has('/2026/05/26-2.md')).toBe(true);
  });

  it('iterates suffix loop until an empty slot is found', async () => {
    // Two existing files both near the cap; -3.md does not exist.
    const cap = 512;
    const filler = 'x'.repeat(cap - 5);
    const mock = makeMockClient([
      {
        type: 'memory',
        id: 'mem_1',
        path: '/2026/05/26.md',
        content: filler,
        content_sha256: 'sha-1',
      },
      {
        type: 'memory',
        id: 'mem_2',
        path: '/2026/05/26-2.md',
        content: filler,
        content_sha256: 'sha-2',
      },
    ]);
    const result = await appendSessionLogMemory(
      deps({ client: mock.client, maxBytes: cap }),
      {
        senderEmail: 'k.seto@makotoprime.com',
        spaceType: 'DM',
        userSlug: 'keisuke-seto',
        memoryAttachments: [DM_ATTACHMENT],
        space: { name: 'spaces/DM1', type: 'DM' },
        sender: { name: 'users/u1' },
        userText: 'u',
        finalText: 'f',
      },
    );
    expect(result.appended).toBe(true);
    expect(result.action).toBe('create');
    expect(result.suffix).toBe(3);
    expect(result.path).toBe('/2026/05/26-3.md');
    expect(mock.store.has('/2026/05/26-3.md')).toBe(true);
  });

  it('exposes SESSION_LOG_MAX_BYTES = 100 * 1024 (byte-equivalent with Python)', () => {
    expect(SESSION_LOG_MAX_BYTES).toBe(100 * 1024);
  });

  it('ignores memory_prefix rollup markers during list traversal', async () => {
    // Inject a memory_prefix item via direct iterator override.
    const realMock = makeMockClient([
      {
        type: 'memory',
        id: 'mem_real',
        path: '/2026/05/26.md',
        content: 'old',
        content_sha256: 'sha-r',
      },
    ]);
    // Wrap list to also yield a prefix marker before the real memory.
    const origList = realMock.client.beta.memoryStores.memories.list.bind(
      realMock.client.beta.memoryStores.memories,
    );
    realMock.client.beta.memoryStores.memories.list = (id: string) => {
      const _real = origList(id);
      return Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'memory_prefix', path: '/2026/05/' };
          for await (const m of (await _real) as unknown as AsyncIterable<unknown>) {
            yield m;
          }
        },
      });
    };
    const result = await appendSessionLogMemory(
      deps({ client: realMock.client }),
      {
        senderEmail: 'k.seto@makotoprime.com',
        spaceType: 'DM',
        userSlug: 'keisuke-seto',
        memoryAttachments: [DM_ATTACHMENT],
        space: { name: 'spaces/DM1', type: 'DM' },
        sender: { name: 'users/u1' },
        userText: 'u',
        finalText: 'f',
      },
    );
    // The real memory still wins (prefix marker is silently ignored).
    expect(result.appended).toBe(true);
    expect(result.action).toBe('update');
    expect(result.path).toBe('/2026/05/26.md');
  });
});
