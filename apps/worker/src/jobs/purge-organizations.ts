import type { WorkerDatabase } from '../common/database/worker-database.js';
import {
  handOrganizationToErasure,
  listDueOrganizations,
} from '../common/database/organization-purge-store.js';
import type { DueOrganization } from '../common/database/organization-purge-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { PURGE_HOOKS } from './purge-sweeper.js';
import type { PurgeHook } from './purge-sweeper.js';

/**
 * platform-admin v2 · PA-07 (SPEC P7) — the organization purge, a `PURGE_HOOKS` entry of
 * `--sweep-purge`. A soft-deleted organization whose restore window has passed (or whose purge a
 * super admin brought forward to now) is handed to the privacy erasure path: one transaction per
 * pass closes each due organization and records an executed company deletion, and the API's
 * privacy job erases its rows and files after its own delay. This file holds no SQL; the store
 * beside the database seam does.
 */

export const ORGANIZATION_PURGE_BATCH = 20;

export interface OrganizationPurgeStore {
  listDue(tx: WorkerTransaction, limit: number): Promise<readonly DueOrganization[]>;
  hand(tx: WorkerTransaction, organization: DueOrganization): Promise<boolean>;
}

export const DEFAULT_ORGANIZATION_PURGE_STORE: OrganizationPurgeStore = {
  listDue: listDueOrganizations,
  hand: handOrganizationToErasure,
};

/** One bounded pass; returns how many organizations were handed to erasure. */
export async function purgeOrganizations(
  database: WorkerDatabase,
  store: OrganizationPurgeStore = DEFAULT_ORGANIZATION_PURGE_STORE,
  batch: number = ORGANIZATION_PURGE_BATCH,
): Promise<number> {
  return database.transaction(async (tx) => {
    const due = await store.listDue(tx, batch);
    let handed = 0;
    for (const organization of due) {
      if (await store.hand(tx, organization)) handed += 1;
    }
    return handed;
  });
}

export const ORGANIZATION_PURGE_HOOK: PurgeHook = {
  name: 'organizations',
  run: (database) => purgeOrganizations(database),
};

if (!PURGE_HOOKS.some((hook) => hook.name === ORGANIZATION_PURGE_HOOK.name)) {
  PURGE_HOOKS.push(ORGANIZATION_PURGE_HOOK);
}
