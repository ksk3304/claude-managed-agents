/**
 * Memory Store attachment types — TS port of
 * `scripts/cma_session_resolver.py:MemoryAttachment` /
 * `ResolvedSessionResources`.
 *
 * Memory Stores are Anthropic Managed Agents primitives: a stored,
 * agent-readable knowledge surface that the per-session `sessions.create`
 * call attaches via the `resources` parameter. Each `MemoryAttachment`
 * here describes one store and is serialized to the SDK's
 * `MemoryStoreResourceParam` shape at session-creation time.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 2 — 層 0 要石 B)
 * Parent: ksk3304/makoto-prime#177 §設計判断 15 項目 7
 */

export type MemoryAccess = 'read_only' | 'read_write';

/**
 * One Memory Store attached to a session.
 *
 * - `memory_store_id`: Anthropic memory store id (e.g. `memstore_xxx`)
 * - `access`: 'read_only' = agent may read, 'read_write' = read+write
 * - `instructions`: per-store guidance surfaced to the agent at session start
 * - `store_name`: human-readable label used in logs / per-user mapping files
 */
export interface MemoryAttachment {
  memory_store_id: string;
  access: MemoryAccess;
  instructions?: string;
  store_name?: string;
}

/**
 * Shape of one element in the `resources` array passed to
 * `client.beta.sessions.create({ resources: [...] })`. See
 * `MemoryAttachment.to_resource_param()` in the Python source.
 *
 * `instructions` is omitted when empty so we don't ship empty strings to
 * the API (matches Python behaviour at `cma_session_resolver.py:218-220`).
 */
export interface MemoryStoreResourceParam {
  type: 'memory_store';
  memory_store_id: string;
  access: MemoryAccess;
  instructions?: string;
}

/** File uploaded through Anthropic Files API and mounted into a session. */
export interface FileResourceParam {
  type: 'file';
  file_id: string;
  mount_path?: string | null;
}

export type SessionResourceParam = MemoryStoreResourceParam | FileResourceParam;

/**
 * `sender_email → user_slug → resources` resolution result. Built by the
 * per-user resolver (TS port of `SessionCredentialResolver.resolve`).
 *
 * Mail-path callers always run with `space_type === 'DM'` and
 * `filtered_personal_store_count === 0`, but the fields are kept so a
 * later R-Chat sub-issue can share the same type.
 */
export interface ResolvedSessionResources {
  sender_email: string;
  user_slug: string;
  memory_attachments: MemoryAttachment[];
  system_prompt_addendum: string;
  is_default: boolean;
  /** 'DM' / 'ROOM' / 'GROUP_CHAT' / etc. Mail path = 'DM'. */
  space_type: string;
  /** Count of personal stores filtered out for shared-space calls. Mail = 0. */
  filtered_personal_store_count: number;
}

/**
 * Convert one `MemoryAttachment` to the SDK `resources` shape.
 * Mirrors `MemoryAttachment.to_resource_param()` (Python).
 */
export function toResourceParam(a: MemoryAttachment): MemoryStoreResourceParam {
  const out: MemoryStoreResourceParam = {
    type: 'memory_store',
    memory_store_id: a.memory_store_id,
    access: a.access,
  };
  if (a.instructions && a.instructions.length > 0) {
    out.instructions = a.instructions;
  }
  return out;
}

/**
 * Convert a `ResolvedSessionResources` to the SDK `resources` array
 * (one `memory_store` element per attachment, in declared order).
 */
export function toResourcesArray(r: ResolvedSessionResources): MemoryStoreResourceParam[] {
  return r.memory_attachments.map(toResourceParam);
}
