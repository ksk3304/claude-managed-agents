/**
 * sender_email → ResolvedSessionResources resolver for the AgentMail
 * bridge. TS port of the mail-path subset of
 * `scripts/cma_session_resolver.py:SessionCredentialResolver.resolve`.
 *
 * The live per-user mapping is written by the parent #177 copy_agent
 * CLI to KV under `user_mapping:<email-lower>`. Mail-path callers
 * read it here. We do not duplicate the write path — anything that
 * needs to register a new user goes through the Python CLI to keep
 * one source of truth.
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
  /**
   * Memory Stores to attach for this user's sessions. Each entry
   * becomes one `MemoryStoreResourceParam` at sessions.create time.
   */
  memory_attachments: MemoryAttachment[];
  /** Optional per-user system-prompt addendum. */
  system_prompt_addendum?: string;
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
