import { sanitizeInlineValue } from './session-log';

export const SPEAKER_ALIAS_PREFIX = 'speaker_alias';
export const SPEAKER_ALIAS_PENDING_PREFIX = 'speaker_alias_pending';
export const SPEAKER_ALIAS_PENDING_TTL_SEC = 30 * 60;

export interface SpeakerAliasEntry {
  label: string;
  source: 'user_confirmed';
  updatedAtMs: number;
  confirmedByEmail?: string;
}

export interface PendingSpeakerAlias {
  spaceName: string;
  senderId: string;
  messageName: string;
  messageText: string;
  requestedByEmail: string;
  createdAtMs: number;
}

export async function readSpeakerAlias(
  kv: KVNamespace,
  spaceName: string,
  senderId: string,
): Promise<SpeakerAliasEntry | null> {
  if (!spaceName || !senderId) return null;
  const raw = await kv.get(speakerAliasKey(spaceName, senderId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SpeakerAliasEntry>;
    const label = sanitizeSpeakerAliasLabel(parsed.label);
    if (!label || parsed.source !== 'user_confirmed') return null;
    return {
      label,
      source: 'user_confirmed',
      updatedAtMs:
        typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
          ? parsed.updatedAtMs
          : 0,
      ...(typeof parsed.confirmedByEmail === 'string'
        ? { confirmedByEmail: parsed.confirmedByEmail }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function writeSpeakerAlias(
  kv: KVNamespace,
  spaceName: string,
  senderId: string,
  label: string,
  options: { confirmedByEmail?: string; nowMs?: number } = {},
): Promise<SpeakerAliasEntry | null> {
  const safeLabel = sanitizeSpeakerAliasLabel(label);
  if (!spaceName || !senderId || !safeLabel) return null;
  const entry: SpeakerAliasEntry = {
    label: safeLabel,
    source: 'user_confirmed',
    updatedAtMs: options.nowMs ?? Date.now(),
    ...(options.confirmedByEmail ? { confirmedByEmail: options.confirmedByEmail } : {}),
  };
  await kv.put(speakerAliasKey(spaceName, senderId), JSON.stringify(entry));
  return entry;
}

export async function readPendingSpeakerAlias(
  kv: KVNamespace,
  spaceName: string,
  requestedByEmail: string,
): Promise<PendingSpeakerAlias | null> {
  if (!spaceName || !requestedByEmail) return null;
  const raw = await kv.get(pendingSpeakerAliasKey(spaceName, requestedByEmail));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSpeakerAlias>;
    if (
      typeof parsed.spaceName !== 'string' ||
      typeof parsed.senderId !== 'string' ||
      typeof parsed.requestedByEmail !== 'string'
    ) {
      return null;
    }
    return {
      spaceName: parsed.spaceName,
      senderId: parsed.senderId,
      messageName: typeof parsed.messageName === 'string' ? parsed.messageName : '',
      messageText: typeof parsed.messageText === 'string' ? parsed.messageText : '',
      requestedByEmail: parsed.requestedByEmail,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)
          ? parsed.createdAtMs
          : 0,
    };
  } catch {
    return null;
  }
}

export async function writePendingSpeakerAlias(
  kv: KVNamespace,
  pending: PendingSpeakerAlias,
): Promise<void> {
  if (!pending.spaceName || !pending.senderId || !pending.requestedByEmail) return;
  await kv.put(
    pendingSpeakerAliasKey(pending.spaceName, pending.requestedByEmail),
    JSON.stringify(pending),
    { expirationTtl: SPEAKER_ALIAS_PENDING_TTL_SEC },
  );
}

export async function clearPendingSpeakerAlias(
  kv: KVNamespace,
  spaceName: string,
  requestedByEmail: string,
): Promise<void> {
  if (!spaceName || !requestedByEmail) return;
  await kv.delete(pendingSpeakerAliasKey(spaceName, requestedByEmail));
}

export function extractAliasLabelFromConfirmation(text: string): string {
  const safe = sanitizeInlineValue(text);
  if (!safe || safe.length > 80) return '';
  if (/[?？]/.test(safe)) return '';
  let out = safe;
  out = out.replace(/^@\S+\s+/, '');
  out = out.replace(/^(それは|これは|この人は|発言者は|話者は)\s*/, '');
  out = out.replace(/(として扱って|としてお願いします|でお願いします|です|だよ|だね|になります)[。.!！]*$/u, '');
  out = out.trim();
  return sanitizeSpeakerAliasLabel(out);
}

export function sanitizeSpeakerAliasLabel(raw: string | null | undefined): string {
  const s = sanitizeInlineValue(raw);
  if (!s) return '';
  let out = s;
  for (const tok of ['EMAIL_SEND', 'CHAT_POST', 'SCHEDULE_ACTION']) {
    out = out.split(`${tok}:`).join(`${tok}∶`);
  }
  out = out.replace(/`/g, 'ˋ').replace(/\[/g, '(').replace(/\]/g, ')');
  out = out.replace(/^[#>*\-+~|\s]+/, '');
  if (out.length > 64) out = out.slice(0, 64) + '…';
  return out.trim();
}

function speakerAliasKey(spaceName: string, senderId: string): string {
  return `${SPEAKER_ALIAS_PREFIX}:${encodeURIComponent(spaceName)}:${encodeURIComponent(senderId)}`;
}

function pendingSpeakerAliasKey(spaceName: string, requestedByEmail: string): string {
  return `${SPEAKER_ALIAS_PENDING_PREFIX}:${encodeURIComponent(spaceName)}:${encodeURIComponent(
    requestedByEmail.toLowerCase(),
  )}`;
}
