import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { FieldCipher, FieldCipherPurpose } from '@tmanage/domain/field-cipher';
import type { SeedKeyring } from '@tmanage/config';
import { createSeedCipher } from '../identity/seed-cipher.js';
import type { SeedCipher } from '../identity/seed-cipher.js';

/**
 * 56-03p. The token vault: the one place a connected app's stored token (OAuth refresh token,
 * API key, Figma token) is sealed and opened. Built on FieldCipher (56-02): AES-256-GCM, the key
 * id inside the `fc1.` envelope, and AAD = purpose + owner, where the owner is the writer's
 * existing binding string (`storage:<org>:<provider>`, `calendar:<org>:<user>:<provider>`,
 * `connector:<org>:<key>`, `figma:<org>:<membership>`). The worker's rotation job rebuilds the same
 * owner from the row's columns (`apps/worker/src/jobs/field-cipher-rotation.ts`), so a new key in
 * `FIELD_CIPHER_KEYS` is rolled onto every row while the older keys keep opening the rest.
 *
 * Before 56-03p these tokens were sealed with the MFA seed ring (`mfa1.` envelopes,
 * `AUTH_MFA_SEED_KEYS`). Those rows still open here, read-only, until
 * `pnpm --filter @tmanage/api token-vault:upgrade` re-seals them; a server without
 * `FIELD_CIPHER_KEYS` keeps sealing on that ring, so a connect never fails and nothing is ever
 * stored in plaintext. Revocation on disconnect is the services' (they open, revoke, wipe).
 *
 * Every failure to open is one constant {@link TokenVaultError}: no reason, key id or value.
 */

export const TOKEN_VAULT_PURPOSES = [
  'storage_token',
  'calendar_token',
  'connector_token',
  'figma_token',
] as const satisfies readonly FieldCipherPurpose[];
export type TokenVaultPurpose = (typeof TOKEN_VAULT_PURPOSES)[number];

/** The writer's binding: `userId` is the owner string, the shape the services already pass. */
export interface TokenBinding {
  readonly userId: string;
}

/** One purpose's seal/open pair, the dependency each connector service takes. */
export interface TokenVaultSlot {
  encrypt(plaintext: string, binding: TokenBinding): string;
  /** Throws {@link TokenVaultError} for anything that is not a sealed token this vault can open. */
  decrypt(stored: string, binding: TokenBinding): string;
}

export const TOKEN_VAULT_ERROR_MESSAGE = 'stored connection token cannot be opened';

export class TokenVaultError extends Error {
  constructor() {
    super(TOKEN_VAULT_ERROR_MESSAGE);
    this.name = 'TokenVaultError';
  }
}

export interface TokenVault {
  slot(purpose: TokenVaultPurpose): TokenVaultSlot;
  /** A legacy `mfa1.` value re-sealed as `fc1.`; `null` when already `fc1.` or keyless. */
  upgrade(purpose: TokenVaultPurpose, stored: string, owner: string): string | null;
}

const LEGACY_PREFIX = 'mfa1.';

export function createTokenVault(deps: {
  readonly fieldCipher: FieldCipher;
  readonly legacy: Pick<SeedCipher, 'encrypt' | 'decrypt'>;
}): TokenVault {
  const { fieldCipher, legacy } = deps;
  const open = (purpose: TokenVaultPurpose, stored: string, owner: string): string => {
    try {
      if (fieldCipher.isEnvelope(stored))
        return fieldCipher.decrypt(stored, { purpose, ownerId: owner });
      if (stored.startsWith(LEGACY_PREFIX)) return legacy.decrypt(stored, { userId: owner });
    } catch {
      throw new TokenVaultError();
    }
    throw new TokenVaultError();
  };
  return {
    slot: (purpose) => ({
      encrypt: (plaintext, binding) =>
        fieldCipher.enabled
          ? fieldCipher.encrypt(plaintext, { purpose, ownerId: binding.userId })
          : legacy.encrypt(plaintext, binding),
      decrypt: (stored, binding) => open(purpose, stored, binding.userId),
    }),
    upgrade(purpose, stored, owner) {
      if (!fieldCipher.enabled || !stored.startsWith(LEGACY_PREFIX)) return null;
      return fieldCipher.encrypt(open(purpose, stored, owner), { purpose, ownerId: owner });
    },
  };
}

/** The vault over this server's environment: `FIELD_CIPHER_KEYS`, and the legacy seed ring. */
export function tokenVaultFromEnv(mfaSeedKeys: SeedKeyring): TokenVault {
  return createTokenVault({
    fieldCipher: createFieldCipher(loadFieldCipherKeyring(process.env)),
    legacy: createSeedCipher(mfaSeedKeys),
  });
}
