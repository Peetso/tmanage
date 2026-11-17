import type { RowDataPacket } from 'mysql2/promise';
import { calendarTokenBinding } from '../google-calendar/google-calendar.service.js';
import { tokenBinding as googleDriveBinding } from '../google-drive/google-drive.service.js';
import { microsoftCalendarTokenBinding } from '../microsoft-calendar/microsoft-calendar.service.js';
import { tokenBinding as oneDriveBinding } from '../onedrive/onedrive.service.js';
import { figmaTokenBinding } from '../figma/figma.service.js';
import { connectorBinding } from './connectors.service.js';
import type { TokenBinding, TokenVault, TokenVaultPurpose } from './token-vault.js';

/**
 * 56-03p. `pnpm --filter @tmanage/api token-vault:upgrade`: moves the token vault's legacy `mfa1.`
 * rows (sealed on the MFA seed ring before 56-03p) to FieldCipher `fc1.` envelopes, after which
 * the worker's key rotation covers them. Same shape as `mfa:encrypt-seeds`: the migration
 * credential, no tenant (a maintenance sweep over every organization), row by row with a
 * compare-and-swap on the value read, and a row that will not open is counted, never rewritten.
 * The owner comes from the writers' own binding functions, so it cannot drift from them.
 * Reports ids and counts only.
 */

export interface VaultUpgradeStore {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

interface VaultTable {
  readonly purpose: TokenVaultPurpose;
  readonly select: string;
  readonly replace: string;
  readonly owner: (row: RowDataPacket) => TokenBinding;
}

const text = (row: RowDataPacket, column: string): string => String(row[column]);

/** Closed map: every SQL string is a literal; nothing comes from a row. */
export const VAULT_TABLES: readonly VaultTable[] = [
  {
    purpose: 'storage_token',
    select: `SELECT id, organization_id, provider, refresh_token_enc AS value
               FROM storage_connections WHERE refresh_token_enc LIKE 'mfa1.%' ORDER BY id`,
    replace: `UPDATE storage_connections SET refresh_token_enc = ?
               WHERE id = ? AND refresh_token_enc = ?`,
    owner: (row) =>
      text(row, 'provider') === 'onedrive'
        ? oneDriveBinding(text(row, 'organization_id'))
        : googleDriveBinding(text(row, 'organization_id')),
  },
  {
    purpose: 'calendar_token',
    select: `SELECT id, organization_id, user_id, provider, refresh_token_enc AS value
               FROM calendar_connections WHERE refresh_token_enc LIKE 'mfa1.%' ORDER BY id`,
    replace: `UPDATE calendar_connections SET refresh_token_enc = ?
               WHERE id = ? AND refresh_token_enc = ?`,
    owner: (row) =>
      text(row, 'provider') === 'microsoft'
        ? microsoftCalendarTokenBinding(text(row, 'organization_id'), text(row, 'user_id'))
        : calendarTokenBinding(text(row, 'organization_id'), text(row, 'user_id')),
  },
  {
    purpose: 'connector_token',
    select: `SELECT id, organization_id, connector_key, credential_enc AS value
               FROM connector_installations WHERE credential_enc LIKE 'mfa1.%' ORDER BY id`,
    replace: `UPDATE connector_installations SET credential_enc = ?
               WHERE id = ? AND credential_enc = ?`,
    owner: (row) => connectorBinding(text(row, 'organization_id'), text(row, 'connector_key')),
  },
  {
    purpose: 'figma_token',
    select: `SELECT id, organization_id, membership_id, token_ciphertext AS value
               FROM figma_connections WHERE token_ciphertext LIKE 'mfa1.%' ORDER BY id`,
    replace: `UPDATE figma_connections SET token_ciphertext = ?
               WHERE id = ? AND token_ciphertext = ?`,
    owner: (row) => figmaTokenBinding(text(row, 'organization_id'), text(row, 'membership_id')),
  },
];

export interface VaultUpgradeReport {
  readonly upgraded: number;
  readonly failed: readonly { readonly purpose: TokenVaultPurpose; readonly id: string }[];
}

/** Re-seal every legacy row as `fc1.`; throws when the vault cannot write `fc1.` (keyless). */
export async function upgradeLegacyTokens(
  store: VaultUpgradeStore,
  vault: TokenVault,
): Promise<VaultUpgradeReport> {
  let upgraded = 0;
  const failed: { purpose: TokenVaultPurpose; id: string }[] = [];
  for (const table of VAULT_TABLES) {
    const [rows] = await store.query(table.select);
    for (const row of rows as RowDataPacket[]) {
      const id = text(row, 'id');
      const value = text(row, 'value');
      let next: string | null;
      try {
        next = vault.upgrade(table.purpose, value, table.owner(row).userId);
      } catch {
        failed.push({ purpose: table.purpose, id });
        continue;
      }
      if (next === null) throw new Error('FIELD_CIPHER_KEYS is not set: nothing can be upgraded');
      const [result] = await store.query(table.replace, [next, id, value]);
      if (Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0) upgraded += 1;
      else failed.push({ purpose: table.purpose, id });
    }
  }
  return { upgraded, failed };
}
