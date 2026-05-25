/**
 * Unit tests for `src/lib/oauth-vault.ts` — AES-GCM-256 + AAD vault.
 */

import { describe, it, expect } from 'vitest';
import {
  deleteRefreshToken,
  getRefreshToken,
  putRefreshToken,
} from '../src/lib/oauth-vault';
import { makeKv, randomVaultKeyB64, TEST_VAULT_KEY_B64 } from './makoto-helpers';

describe('oauth-vault round-trip', () => {
  it('encrypts and decrypts a refresh_token for the same user', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'secret-token-1');
    const got = await getRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice');
    expect(got).toBe('secret-token-1');
  });

  it('returns null for missing entries', async () => {
    const kv = makeKv();
    expect(await getRefreshToken(kv, TEST_VAULT_KEY_B64, 'missing')).toBeNull();
  });

  it('refuses cross-user decryption (AAD fence)', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'alice-token');
    // Move the KV entry to bob's key — the encrypted blob is alice's
    // but the AAD on decrypt becomes bob, so the AES-GCM verification
    // throws OperationError.
    const aliceKey = 'vault:oauth:alice:refresh_token';
    const bobKey = 'vault:oauth:bob:refresh_token';
    const stolen = await kv.get(aliceKey);
    await kv.put(bobKey, stolen!);
    await expect(getRefreshToken(kv, TEST_VAULT_KEY_B64, 'bob')).rejects.toThrow();
  });

  it('decryption fails with a different vault key', async () => {
    const kv = makeKv();
    const keyA = TEST_VAULT_KEY_B64;
    const keyB = randomVaultKeyB64();
    await putRefreshToken(kv, keyA, 'alice', 'tok');
    await expect(getRefreshToken(kv, keyB, 'alice')).rejects.toThrow();
  });

  it('deleteRefreshToken removes the entry idempotently', async () => {
    const kv = makeKv();
    await putRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice', 'tok');
    await deleteRefreshToken(kv, 'alice');
    expect(await getRefreshToken(kv, TEST_VAULT_KEY_B64, 'alice')).toBeNull();
    // Second delete must not throw.
    await deleteRefreshToken(kv, 'alice');
  });

  it('rejects malformed user_slug (no slashes / colons)', async () => {
    const kv = makeKv();
    await expect(
      putRefreshToken(kv, TEST_VAULT_KEY_B64, 'evil:slug', 'x'),
    ).rejects.toThrow(/invalid user_slug/);
    await expect(
      putRefreshToken(kv, TEST_VAULT_KEY_B64, 'evil/slug', 'x'),
    ).rejects.toThrow(/invalid user_slug/);
  });

  it('rejects a vault key with wrong byte length', async () => {
    const kv = makeKv();
    const shortKey = btoa('shortkey'); // 8 bytes, not 32
    await expect(putRefreshToken(kv, shortKey, 'alice', 'x')).rejects.toThrow(
      /OAUTH_VAULT_KEY/,
    );
  });
});
