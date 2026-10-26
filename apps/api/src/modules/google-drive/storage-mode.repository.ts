import { and, eq, ne, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { storageConnections } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * One effective storage mode per organization (0236).
 *
 * `storage_connections` keeps one row per provider (`google_drive`, `onedrive`), and each row's
 * `storage_mode` is either `tmanage` or that row's own provider. The company's storage is the row
 * whose mode is not `tmanage` (and that is not disconnected); with none, it is TManage storage.
 * {@link switchStorageMode} is the only writer of the mode: it sets the chosen provider's row and
 * resets every other provider's row to `tmanage` in the same transaction, so two providers can
 * never both claim new files.
 */

export type StorageProvider = 'google_drive' | 'onedrive';
export type StorageMode = 'tmanage' | StorageProvider;

export const STORAGE_PROVIDERS: readonly StorageProvider[] = ['google_drive', 'onedrive'];

export function isStorageProvider(value: unknown): value is StorageProvider {
  return value === 'google_drive' || value === 'onedrive';
}

/** The provider whose row holds the company's files, or `tmanage`. */
export async function effectiveStorageMode(
  runner: TenantQueryRunner,
  context: TenantContext,
): Promise<StorageMode> {
  const rows = await tenantDrizzle(runner)
    .select({
      provider: storageConnections.provider,
      storageMode: storageConnections.storageMode,
      status: storageConnections.status,
    })
    .from(storageConnections)
    .where(eq(storageConnections.organizationId, context.organizationId));
  return effectiveModeOf(rows);
}

/** Pure half of {@link effectiveStorageMode}: the first live row whose mode is its provider. */
export function effectiveModeOf(
  rows: readonly { provider: string; storageMode: string; status: string }[],
): StorageMode {
  const active = rows
    .filter(
      (row) =>
        row.status !== 'disconnected' &&
        isStorageProvider(row.provider) &&
        row.storageMode === row.provider,
    )
    .map((row) => row.provider as StorageProvider)
    .sort((a, b) => STORAGE_PROVIDERS.indexOf(a) - STORAGE_PROVIDERS.indexOf(b));
  return active[0] ?? 'tmanage';
}

/**
 * Make `mode` the company's storage: the chosen provider's row gets its own provider as mode and
 * every other provider's row goes back to `tmanage`. Run it inside the caller's transaction, after
 * the caller has checked that the chosen provider is connected.
 */
export async function switchStorageMode(
  runner: TenantQueryRunner,
  context: TenantContext,
  mode: StorageMode,
): Promise<void> {
  const db = tenantDrizzle(runner);
  await db
    .update(storageConnections)
    .set({ storageMode: 'tmanage', updatedAt: sql`current_timestamp(3)` })
    .where(
      and(
        eq(storageConnections.organizationId, context.organizationId),
        ne(storageConnections.storageMode, 'tmanage'),
        ...(mode === 'tmanage' ? [] : [ne(storageConnections.provider, mode)]),
      ),
    );
  if (mode === 'tmanage') return;
  await db
    .update(storageConnections)
    .set({ storageMode: mode, updatedAt: sql`current_timestamp(3)` })
    .where(
      and(
        eq(storageConnections.organizationId, context.organizationId),
        eq(storageConnections.provider, mode),
      ),
    );
}

/** The two operations, as one injectable seam (unit tests replace it with an in-memory fake). */
export interface StorageModeStore {
  effective(runner: TenantQueryRunner, context: TenantContext): Promise<StorageMode>;
  switchTo(runner: TenantQueryRunner, context: TenantContext, mode: StorageMode): Promise<void>;
}

export const databaseStorageModes: StorageModeStore = {
  effective: effectiveStorageMode,
  switchTo: switchStorageMode,
};
