import type { WorkerTransaction } from './worker-database.js';

/**
 * H3 — the reads the privacy emails need (`consumers/privacy-mail.ts`). Organization-scoped by the
 * event's own organization, re-read at delivery like every other mail consumer's facts: three tables
 * the worker already holds SELECT on (`users`, `organizations`, `memberships`), nothing written.
 */

export interface PrivacyMailRecipient {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
}

export interface PrivacyMailOrganization {
  readonly name: string;
  readonly slug: string;
}

/** The studio's name and slug (for the link). Null when the row is gone. */
export async function findPrivacyMailOrganization(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<PrivacyMailOrganization | null> {
  const rows = await tx.query<readonly { name: string; slug: string }[]>(
    `SELECT o.name, o.slug FROM organizations o WHERE o.id = ?`,
    [organizationId],
  );
  const row = rows[0];
  return row === undefined ? null : { name: row.name, slug: row.slug };
}

/**
 * The people a privacy email may go to, by id: each must still hold a membership of this
 * organization (any status — an offboarded person is told their account deletion was carried out),
 * and the user row must exist. Unknown ids are simply absent.
 */
export async function findPrivacyMailRecipients(
  tx: WorkerTransaction,
  organizationId: string,
  userIds: readonly string[],
): Promise<readonly PrivacyMailRecipient[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const rows = await tx.query<
    readonly { id: string; email: string; display_name: string; locale: string | null }[]
  >(
    `SELECT u.id, u.email, u.display_name, u.locale
       FROM users u
      WHERE u.id IN (${ids.map(() => '?').join(', ')})
        AND EXISTS (SELECT 1 FROM memberships m
                     WHERE m.organization_id = ? AND m.user_id = u.id)
      ORDER BY u.id`,
    [...ids, organizationId],
  );
  return rows.map((row) => ({
    userId: row.id,
    email: row.email,
    displayName: row.display_name,
    locale: row.locale ?? 'en',
  }));
}

/** The organization's active owners — who a company deletion is told to. */
export async function listActiveOwnerIds(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { user_id: string }[]>(
    `SELECT m.user_id FROM memberships m
      WHERE m.organization_id = ? AND m.role = 'owner' AND m.status = 'active'
      ORDER BY m.user_id`,
    [organizationId],
  );
  return rows.map((row) => row.user_id);
}
