/**
 * sender_email → ResolvedSessionResources resolver for the AgentMail
 * bridge. TS port of the mail-path subset of
 * `scripts/cma_session_resolver.py:SessionCredentialResolver.resolve`.
 *
 * The live per-user mapping is written by the parent #177 copy_agent
 * CLI to KV under `user_mapping:<email-lower>`. Mail-path callers
 * read it here. Full user registration still goes through the onboarding
 * CLI. Chat can create separate pending mappings under
 * `chat_pending_user_mapping:*`; those are intentionally not full
 * `user_mapping:*` registrations.
 *
 * Mail path is always `space_type='DM'` and
 * `filtered_personal_store_count=0` (mail is inherently per-recipient
 * — no shared-space filtering needed; see Python comment at
 * cma_session_resolver.py:186-199).
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 5 — 層 3)
 * Spec: plan-draft.md §5 Memory Store + A8 / A9
 */

import type {
  MemoryAttachment,
  ResolvedSessionResources,
  MemoryStoreResourceParam,
} from '../types/memory';
import { toResourcesArray } from '../types/memory';

const KV_USER_MAPPING_PREFIX = 'user_mapping';
const CHAT_PENDING_USER_MAPPING_PREFIX = 'chat_pending_user_mapping';

/**
 * Shape of `user_mapping:<email>` values in KV. Written by the parent
 * #177 copy_agent CLI; read here. Optional fields cover the v1
 * mapping schema kept for backwards compat (Python's
 * SessionCredentialResolver does the same).
 */
export interface UserMappingValue {
  user_slug: string;
  /** Anthropic agent id this user is bound to (1 user = 1 agent). */
  agent_id: string;
  /** Memory store ids that must not be attached in shared spaces. */
  personal_memory_store_ids?: string[];
  /**
   * Memory Stores to attach for this user's sessions. Each entry
   * becomes one `MemoryStoreResourceParam` at sessions.create time.
   */
  memory_attachments: MemoryAttachment[];
  /** Optional per-user system-prompt addendum. */
  system_prompt_addendum?: string;
  /** Observability count added by `filterPersonalMemoryForSpace`. */
  filtered_personal_store_count?: number;
  /** False for auto-created chat-only pending mappings. Missing means trusted legacy mapping. */
  actor_trusted?: boolean;
  /** True when the mapping was created from a Chat sender event and still needs promotion. */
  auto_registered?: boolean;
  /** Stable Google Chat user resource id (`users/<id>`) when known. */
  chat_user_id?: string;
  /** Display name observed from Google Chat when known. */
  display_name?: string;
  /** Source marker for audit/debugging. */
  mapping_source?: string;
  /** Creation timestamp for auto-created mappings. */
  registered_at_ms?: number;
}

/**
 * Resolved by `resolveSenderToResources`. On the mail path the
 * resources array hands straight to `sessions.create({ resources })`.
 */
export interface MailRouteResolution {
  user_slug: string;
  agent_id: string;
  resources: MemoryStoreResourceParam[];
  full: ResolvedSessionResources;
}

/**
 * Normalize an email address to the form copy_agent stores under
 * (lowercase, trimmed, `+tag` stripped from the local part — same as
 * `cma_session_resolver.py:_normalize_email`).
 */
export function normalizeSenderEmail(raw: string): string {
  const trimmed = raw.trim();
  // Strip `Display Name <addr>` wrapper if present.
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : trimmed).toLowerCase().trim();
  const at = addr.lastIndexOf('@');
  if (at === -1) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf('+');
  const base = plus === -1 ? local : local.slice(0, plus);
  return `${base}@${domain}`;
}

/**
 * Result of `readUserMappingWithDefault` — wraps the mapping with an
 * `isDefault` flag so the caller can log / mark default-route resolutions
 * separately from direct hits. Same shape as `UserMappingValue` plus the
 * flag (Issue #186 follow-up #8).
 */
export interface UserMappingResolution {
  mapping: UserMappingValue;
  isDefault: boolean;
  actorTrusted: boolean;
  source: 'direct' | 'default' | 'auto_pending';
}

export interface ChatSenderIdentity {
  senderEmail?: string;
  chatUserId?: string;
  displayName?: string;
  spaceName?: string;
  nowMs?: number;
}

/**
 * Chat-path mapping resolver with optional `default` fallback. Ported
 * from `cma_session_resolver.py:SessionCredentialResolver.resolve`
 * (l.418-446) — when sender_email is not in `users`, fall back to a
 * `default` entry if one exists.
 *
 * Lookup order:
 *   1. `user_mapping:<email>` (exact, normalized email)
 *   2. `user_mapping:<defaultSlug>` (only when `defaultSlug` is set and #1 misses)
 *   3. any `user_mapping:*` whose JSON `user_slug` equals `defaultSlug`
 *
 * Returns `null` when both miss → caller skips with `unknown_sender`
 * (legacy behaviour preserved when `defaultSlug` is unset / blank or
 * its mapping is absent from KV).
 *
 * NB: This is intentionally chat-path only. The mail-path resolver
 * (`resolveSenderToResources` below) keeps fail-close semantics —
 * misrouting a mail to the wrong identity is worse than dropping it
 * (private-data exposure risk; see Python comment at
 * cma_session_resolver.py:441-444 about not leaking raw email in
 * exception args).
 */
export async function readUserMappingWithDefault(
  kv: KVNamespace,
  senderEmail: string,
  defaultSlug: string | undefined,
  spaceType: string = 'DM',
): Promise<UserMappingResolution | null> {
  const direct = await readUserMapping(kv, senderEmail);
  if (direct !== null) {
    return {
      mapping: filterPersonalMemoryForSpace(direct, spaceType),
      isDefault: false,
      actorTrusted: direct.actor_trusted !== false && direct.auto_registered !== true,
      source: 'direct',
    };
  }
  if (!defaultSlug) return null;
  const slug = defaultSlug.trim();
  if (slug.length === 0) return null;
  // `default` mapping is stored under the same KV prefix as named users
  // so the parent CLI can write it the same way as any other entry
  // (`scripts/cma_memory_init.py` convention). Python keeps `default`
  // inside the same JSON file; the KV port flattens to a dedicated key.
  const raw = await kv.get(`${KV_USER_MAPPING_PREFIX}:${slug}`, 'json');
  const byStoredSlug =
    raw === null ? await readUserMappingByUserSlug(kv, slug) : null;
  const mapping = raw === null ? byStoredSlug?.mapping : (raw as UserMappingValue);
  if (!mapping) return null;
  return {
    mapping: filterPersonalMemoryForSpace(mapping, spaceType),
    isDefault: true,
    actorTrusted: false,
    source: 'default',
  };
}

/**
 * Chat-path resolver that can create a chat-only pending mapping for an
 * unknown sender. The pending entry deliberately uses a separate KV prefix
 * (`chat_pending_user_mapping:*`) so mail, daily reports, and onboarding code
 * that list/read `user_mapping:*` cannot accidentally treat the person as a
 * fully registered user.
 */
export async function readChatSenderMappingWithAutoPending(
  kv: KVNamespace,
  identity: ChatSenderIdentity,
  defaultSlug: string | undefined,
  spaceType: string = 'DM',
  autoCreatePending = false,
): Promise<UserMappingResolution | null> {
  const email = identity.senderEmail ? normalizeSenderEmail(identity.senderEmail) : '';
  if (email) {
    const direct = await readUserMapping(kv, email);
    if (direct !== null) {
      return {
        mapping: filterPersonalMemoryForSpace(direct, spaceType),
        isDefault: false,
        actorTrusted: direct.actor_trusted !== false && direct.auto_registered !== true,
        source: 'direct',
      };
    }
  }

  const pendingKeys = autoCreatePending ? pendingMappingKeys(email, identity.chatUserId) : [];
  for (const key of pendingKeys) {
    const pending = await readPendingChatMapping(kv, key, spaceType);
    if (pending) return pending;
  }

  const defaultMapping = await readDefaultMapping(kv, defaultSlug);
  if (!defaultMapping) return null;

  if (autoCreatePending && pendingKeys.length > 0) {
    const pendingValue: UserMappingValue = {
      ...defaultMapping,
      actor_trusted: false,
      auto_registered: true,
      chat_user_id: identity.chatUserId?.trim() || undefined,
      display_name: identity.displayName?.trim() || undefined,
      mapping_source: 'chat_auto_pending',
      registered_at_ms: identity.nowMs ?? Date.now(),
      system_prompt_addendum: appendPendingAddendum(defaultMapping.system_prompt_addendum),
    };
    const serialized = JSON.stringify(pendingValue);
    for (const key of pendingKeys) {
      await kv.put(key, serialized);
    }
    return {
      mapping: filterPersonalMemoryForSpace(pendingValue, spaceType),
      isDefault: true,
      actorTrusted: false,
      source: 'auto_pending',
    };
  }

  return {
    mapping: filterPersonalMemoryForSpace(defaultMapping, spaceType),
    isDefault: true,
    actorTrusted: false,
    source: 'default',
  };
}

function pendingMappingKeys(email: string, chatUserId: string | undefined): string[] {
  const keys: string[] = [];
  if (email) keys.push(`${CHAT_PENDING_USER_MAPPING_PREFIX}:email:${email}`);
  const userId = chatUserId?.trim();
  if (userId) {
    keys.push(`${CHAT_PENDING_USER_MAPPING_PREFIX}:user:${encodeURIComponent(userId)}`);
  }
  return [...new Set(keys)];
}

async function readPendingChatMapping(
  kv: KVNamespace,
  key: string,
  spaceType: string,
): Promise<UserMappingResolution | null> {
  const raw = await kv.get(key, 'json');
  if (raw === null) return null;
  const mapping = raw as UserMappingValue;
  return {
    mapping: filterPersonalMemoryForSpace(mapping, spaceType),
    isDefault: true,
    actorTrusted: false,
    source: 'auto_pending',
  };
}

async function readDefaultMapping(
  kv: KVNamespace,
  defaultSlug: string | undefined,
): Promise<UserMappingValue | null> {
  if (!defaultSlug) return null;
  const slug = defaultSlug.trim();
  if (slug.length === 0) return null;
  const raw = await kv.get(`${KV_USER_MAPPING_PREFIX}:${slug}`, 'json');
  if (raw !== null) return raw as UserMappingValue;
  const byStoredSlug = await readUserMappingByUserSlug(kv, slug);
  return byStoredSlug?.mapping ?? null;
}

function appendPendingAddendum(base: string | undefined): string {
  const pending =
    'この発言者は Google Chat から自動検出された未昇格ユーザーです。通常応答のみ行い、メール送信・予定操作・別スペース投稿などの外部副作用は実行しません。';
  const trimmed = base?.trim();
  return trimmed ? `${trimmed}\n\n${pending}` : pending;
}

export function isSharedSpace(spaceType: string): boolean {
  const normalized = (spaceType || '').trim().toUpperCase();
  return normalized !== 'DM' && normalized !== 'DIRECT_MESSAGE';
}

export function filterPersonalMemoryForSpace(
  mapping: UserMappingValue,
  spaceType: string,
): UserMappingValue {
  const personalIds = new Set(mapping.personal_memory_store_ids ?? []);
  if (!isSharedSpace(spaceType) || personalIds.size === 0) {
    return {
      ...mapping,
      memory_attachments: [...mapping.memory_attachments],
      filtered_personal_store_count: 0,
    };
  }
  const memoryAttachments = mapping.memory_attachments.filter(
    (a) => !personalIds.has(a.memory_store_id),
  );
  return {
    ...mapping,
    memory_attachments: memoryAttachments,
    filtered_personal_store_count:
      mapping.memory_attachments.length - memoryAttachments.length,
  };
}

/**
 * Read one `user_mapping:<email>` KV entry. Returns null when absent;
 * caller decides whether to fall back to a `default` mapping or
 * fail-close.
 */
export async function readUserMapping(
  kv: KVNamespace,
  senderEmail: string,
): Promise<UserMappingValue | null> {
  const email = normalizeSenderEmail(senderEmail);
  const raw = await kv.get(`${KV_USER_MAPPING_PREFIX}:${email}`, 'json');
  if (raw === null) return null;
  // We trust the writer (Python CLI) to produce a valid shape — a
  // schema check here would be a second source of truth and drift
  // over time. Cast and let downstream surface any mismatch.
  return raw as UserMappingValue;
}

/**
 * Reverse lookup a user mapping by agent id. Used by AgentMail
 * continuation mail: the counterparty may be external and absent from
 * `user_mapping:<email>`, but the originating sent message already tells
 * us which MAKOTO agent/session owns the thread.
 */
export async function readUserMappingByAgentId(
  kv: KVNamespace,
  agentId: string,
): Promise<{ email: string; mapping: UserMappingValue } | null> {
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listResult = await kv.list({
      prefix: `${KV_USER_MAPPING_PREFIX}:`,
      cursor,
    });
    for (const entry of listResult.keys) {
      const value = (await kv.get(entry.name, 'json')) as UserMappingValue | null;
      if (value?.agent_id === agentId) {
        return {
          email: entry.name.slice(`${KV_USER_MAPPING_PREFIX}:`.length),
          mapping: value,
        };
      }
    }
    if (listResult.list_complete) break;
    cursor = listResult.cursor;
    if (!cursor) break;
  }
  return null;
}

/**
 * Resolve `DEFAULT_USER_SLUG` against production's actual KV shape.
 *
 * The onboarding writer stores mappings under email keys
 * (`user_mapping:k.seto@...`) and puts the slug inside the JSON
 * (`user_slug: "k-seto"`). Some callers only know the slug, so the
 * fallback must scan values rather than require a duplicate
 * `user_mapping:k-seto` key.
 */
export async function readUserMappingByUserSlug(
  kv: KVNamespace,
  userSlug: string,
): Promise<{ email: string; mapping: UserMappingValue } | null> {
  const slug = userSlug.trim();
  if (slug.length === 0) return null;
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listResult = await kv.list({
      prefix: `${KV_USER_MAPPING_PREFIX}:`,
      cursor,
    });
    for (const entry of listResult.keys) {
      const value = (await kv.get(entry.name, 'json')) as UserMappingValue | null;
      if (value?.user_slug === slug) {
        return {
          email: entry.name.slice(`${KV_USER_MAPPING_PREFIX}:`.length),
          mapping: value,
        };
      }
    }
    if (listResult.list_complete) break;
    cursor = listResult.cursor;
    if (!cursor) break;
  }
  return null;
}

/**
 * Full mail-path resolver. Reads the per-user mapping, builds the
 * resources array sessions.create needs, and returns both the raw
 * resolution (for logging) and the wire-format resources list.
 *
 * Returns null when the sender is unknown — callers MUST fail-close
 * (drop the mail / surface an error) rather than silently route to
 * a default agent, because misrouting a mail to the wrong identity
 * is worse than dropping it (private-data exposure risk).
 */
export async function resolveSenderToResources(
  kv: KVNamespace,
  senderEmail: string,
): Promise<MailRouteResolution | null> {
  const mapping = await readUserMapping(kv, senderEmail);
  if (mapping === null) return null;
  const full: ResolvedSessionResources = {
    sender_email: normalizeSenderEmail(senderEmail),
    user_slug: mapping.user_slug,
    memory_attachments: mapping.memory_attachments,
    system_prompt_addendum: mapping.system_prompt_addendum ?? '',
    is_default: false,
    space_type: 'DM',
    filtered_personal_store_count: 0,
  };
  return {
    user_slug: mapping.user_slug,
    agent_id: mapping.agent_id,
    resources: toResourcesArray(full),
    full,
  };
}
