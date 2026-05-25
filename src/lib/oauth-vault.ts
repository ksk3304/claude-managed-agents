/**
 * KV-backed encrypted vault for per-user OAuth refresh_tokens.
 *
 * Storage scheme (parent #177 §設計判断 15 item 5 + plan-draft S1):
 *   - Key: `vault:oauth:<user_slug>:refresh_token`
 *   - Value: JSON-encoded ciphertext envelope (see `VaultEnvelope`)
 *   - Cipher: AES-GCM-256
 *   - Key material: `OAUTH_VAULT_KEY` Worker secret (base64-encoded
 *     32-byte key). Generated once per environment, rotated by writing
 *     all entries with the new key.
 *   - AAD (Additional Authenticated Data): `user_slug` UTF-8 bytes.
 *     This prevents cross-user replay: ciphertext written for user A
 *     cannot be decrypted with user B's `user_slug` in the AAD slot.
 *
 * Cloudflare Workers expose `crypto.subtle` natively — same surface
 * as the Web Crypto API.
 *
 * Issue: ksk3304/makoto-prime#186 (Phase 6 step 4 — 層 2)
 * Spec: plan-draft.md §7 OAuth + §S1 / §S2
 */

const VAULT_PREFIX = 'vault:oauth';
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const IV_LENGTH = 12; // AES-GCM 96-bit IV
const KEY_BIT_LENGTH = 256;

export interface VaultEnvelope {
  /** Envelope format version — bump on breaking change. */
  v: 1;
  /** Algorithm tag — informational; future-proofing. */
  alg: 'AES-GCM-256';
  /** Base64-encoded 12-byte IV. */
  iv: string;
  /** Base64-encoded ciphertext + auth tag. */
  ct: string;
}

export interface VaultOptions {
  /** Override the KV prefix (for tests). */
  prefix?: string;
}

/**
 * Encrypt + persist a refresh_token under `vault:oauth:<user_slug>:
 * refresh_token`. Throws on any crypto failure (caller is expected to
 * audit-log the failure and surface a 500).
 */
export async function putRefreshToken(
  kv: KVNamespace,
  vaultKeyB64: string,
  userSlug: string,
  refreshToken: string,
  options: VaultOptions = {},
): Promise<void> {
  assertSlug(userSlug);
  const key = await importKey(vaultKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aad = ENCODER.encode(userSlug);
  const plaintext = ENCODER.encode(refreshToken);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      plaintext,
    ),
  );
  const envelope: VaultEnvelope = {
    v: 1,
    alg: 'AES-GCM-256',
    iv: b64encode(iv),
    ct: b64encode(ct),
  };
  await kv.put(buildKey(userSlug, options.prefix), JSON.stringify(envelope));
}

/**
 * Read + decrypt a refresh_token. Returns null when the key is
 * absent. Throws on AAD mismatch (cross-user) or any crypto failure —
 * callers MUST catch and audit-log these as `fail_decrypt` /
 * `fail_cross_user`.
 */
export async function getRefreshToken(
  kv: KVNamespace,
  vaultKeyB64: string,
  userSlug: string,
  options: VaultOptions = {},
): Promise<string | null> {
  assertSlug(userSlug);
  const raw = await kv.get(buildKey(userSlug, options.prefix));
  if (raw === null) return null;
  const env = JSON.parse(raw) as VaultEnvelope;
  if (env.v !== 1 || env.alg !== 'AES-GCM-256') {
    throw new Error(`unsupported vault envelope: v=${env.v} alg=${env.alg}`);
  }
  const key = await importKey(vaultKeyB64);
  const iv = b64decode(env.iv);
  const ct = b64decode(env.ct);
  const aad = ENCODER.encode(userSlug);
  // AES-GCM throws on AAD mismatch (= cross-user replay) and on
  // ciphertext tampering — both surface as `OperationError` from
  // `crypto.subtle.decrypt`.
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      ct,
    ),
  );
  return DECODER.decode(plaintext);
}

/**
 * Delete the refresh_token entry. Idempotent.
 */
export async function deleteRefreshToken(
  kv: KVNamespace,
  userSlug: string,
  options: VaultOptions = {},
): Promise<void> {
  assertSlug(userSlug);
  await kv.delete(buildKey(userSlug, options.prefix));
}

// ----------------------------------------------------------------

function buildKey(userSlug: string, prefix?: string): string {
  const p = prefix ?? VAULT_PREFIX;
  return `${p}:${userSlug}:refresh_token`;
}

/**
 * Restrict slug shape so we can't accidentally put a stray `:` into
 * the KV key and collide with a sibling namespace.
 */
function assertSlug(userSlug: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(userSlug)) {
    throw new Error(`invalid user_slug: ${JSON.stringify(userSlug)}`);
  }
}

async function importKey(vaultKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(vaultKeyB64);
  if (raw.byteLength * 8 !== KEY_BIT_LENGTH) {
    throw new Error(
      `OAUTH_VAULT_KEY must decode to ${KEY_BIT_LENGTH / 8} bytes, got ${raw.byteLength}`,
    );
  }
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

// btoa / atob are available in Workers — we wrap them with
// Uint8Array conversion so callers don't have to.
function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
