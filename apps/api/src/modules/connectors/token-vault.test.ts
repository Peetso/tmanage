import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { createFieldCipher, parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { createTokenVault, TOKEN_VAULT_ERROR_MESSAGE } from './token-vault.js';
import { upgradeLegacyTokens, type VaultUpgradeStore } from './token-vault-upgrade.repository.js';

const key = () => randomBytes(32).toString('base64');
const K1 = key();
const legacy = createSeedCipher(parseSeedKeys(`1:${randomBytes(32).toString('base64url')}`));
const vaultWith = (keys: string | null) =>
  createTokenVault({
    fieldCipher: createFieldCipher(keys === null ? null : parseFieldCipherKeys(keys)),
    legacy,
  });
const OWNER = { userId: 'connector:org-1:github' };
const TOKEN = 'gho_throwaway-test-token-0001';

describe('token vault (56-03p)', () => {
  it('never stores a token unencrypted: an fc1 envelope under the purpose and key id', () => {
    const sealed = vaultWith(`1:${K1}`).slot('connector_token').encrypt(TOKEN, OWNER);
    expect(sealed.startsWith('fc1.connector_token.1.')).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(vaultWith(null).slot('connector_token').encrypt(TOKEN, OWNER)).toMatch(/^mfa1\./);
  });

  it('opens old-key and legacy rows after a new key is added, until they are rotated', () => {
    const old = vaultWith(`1:${K1}`).slot('figma_token').encrypt(TOKEN, OWNER);
    const rotated = vaultWith(`1:${K1};2:${key()}`);
    expect(rotated.slot('figma_token').decrypt(old, OWNER)).toBe(TOKEN);
    expect(rotated.slot('figma_token').decrypt(legacy.encrypt(TOKEN, OWNER), OWNER)).toBe(TOKEN);
  });

  it('refuses plaintext, another owner and another purpose with one constant message', () => {
    const vault = vaultWith(`1:${K1}`);
    const sealed = vault.slot('storage_token').encrypt(TOKEN, OWNER);
    for (const attempt of [
      () => vault.slot('storage_token').decrypt(TOKEN, OWNER),
      () => vault.slot('storage_token').decrypt(sealed, { userId: 'connector:org-2:github' }),
      () => vault.slot('calendar_token').decrypt(sealed, OWNER),
    ]) {
      expect(attempt).toThrow(TOKEN_VAULT_ERROR_MESSAGE);
    }
  });

  it('upgrades every legacy row with a compare-and-swap and reports a lost race', async () => {
    const vault = vaultWith(`1:${K1}`);
    const rows = [0, 1, 2].map((i) => ({
      id: `r${i}`,
      organization_id: 'org-1',
      connector_key: 'github',
      value: legacy.encrypt(`${TOKEN}${i}`, OWNER),
    }));
    const writes: unknown[][] = [];
    const store: VaultUpgradeStore = {
      query: async (sql, values) => {
        if (sql.startsWith('SELECT'))
          return [sql.includes('connector_installations') ? rows : [], []];
        writes.push(values ?? []);
        return [{ affectedRows: values?.[1] === 'r2' ? 0 : 1 }, []];
      },
    };
    const report = await upgradeLegacyTokens(store, vault);
    expect(report).toEqual({ upgraded: 2, failed: [{ purpose: 'connector_token', id: 'r2' }] });
    expect(writes).toHaveLength(3);
    const first = writes[0] as [string, string, string];
    expect(first[2]).toBe(rows[0]?.value);
    expect(vault.slot('connector_token').decrypt(first[0], OWNER)).toBe(`${TOKEN}0`);
  });
});
