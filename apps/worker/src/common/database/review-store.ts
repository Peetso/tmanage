import type { WorkerTransaction } from './worker-database.js';

/**
 * R4 slice 12 — the reads the review notices need: a thread's number and audience, the people who
 * wrote on it, and the file it is about. Every statement names the organization the triggering event
 * carries, and every answer comes from the *current* rows at delivery: a deleted thread or file is
 * `null`, and a deleted reply no longer makes its author a participant.
 *
 * `created_by_membership_id` names an internal membership or a client membership, so a participant
 * is resolved through whichever of the two tables holds that id.
 */

export interface ReviewThreadFacts {
  readonly number: number;
  readonly audience: 'internal' | 'client_visible';
  readonly subjectType: string;
  readonly subjectId: string;
  readonly projectId: string;
}

export async function findReviewThreadFacts(
  tx: WorkerTransaction,
  organizationId: string,
  threadId: string,
): Promise<ReviewThreadFacts | null> {
  const rows = await tx.query<
    readonly {
      number: number;
      audience: string;
      subject_type: string;
      subject_id: string;
      project_id: string;
    }[]
  >(
    `SELECT t.number, t.audience, t.subject_type, t.subject_id, t.project_id
       FROM review_threads t
      WHERE t.organization_id = ? AND t.id = ? AND t.deleted_at IS NULL`,
    [organizationId, threadId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    number: Number(row.number),
    audience: row.audience === 'client_visible' ? 'client_visible' : 'internal',
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    projectId: row.project_id,
  };
}

/** The user ids of everyone with a live reply on the thread, oldest participant first. */
export async function listReviewThreadParticipants(
  tx: WorkerTransaction,
  organizationId: string,
  threadId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { user_id: string | null }[]>(
    `SELECT COALESCE(m.user_id, cm.user_id) AS user_id, MIN(c.created_at) AS first_at
       FROM review_comments c
       LEFT JOIN memberships m
         ON m.organization_id = c.organization_id AND m.id = c.created_by_membership_id
       LEFT JOIN client_memberships cm
         ON cm.organization_id = c.organization_id AND cm.id = c.created_by_membership_id
      WHERE c.organization_id = ? AND c.thread_id = ? AND c.deleted_at IS NULL
      GROUP BY COALESCE(m.user_id, cm.user_id)
      ORDER BY first_at`,
    [organizationId, threadId],
  );
  return rows.flatMap((row) => (typeof row.user_id === 'string' ? [row.user_id] : []));
}

/** Everyone with a live reply on any live thread about the subject (for decisions). */
export async function listReviewSubjectParticipants(
  tx: WorkerTransaction,
  organizationId: string,
  subjectId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { user_id: string | null }[]>(
    `SELECT COALESCE(m.user_id, cm.user_id) AS user_id, MIN(c.created_at) AS first_at
       FROM review_threads t
       JOIN review_comments c
         ON c.organization_id = t.organization_id AND c.thread_id = t.id
       LEFT JOIN memberships m
         ON m.organization_id = c.organization_id AND m.id = c.created_by_membership_id
       LEFT JOIN client_memberships cm
         ON cm.organization_id = c.organization_id AND cm.id = c.created_by_membership_id
      WHERE t.organization_id = ? AND t.subject_type = 'file_asset' AND t.subject_id = ?
        AND t.deleted_at IS NULL AND c.deleted_at IS NULL
      GROUP BY COALESCE(m.user_id, cm.user_id)
      ORDER BY first_at`,
    [organizationId, subjectId],
  );
  return rows.flatMap((row) => (typeof row.user_id === 'string' ? [row.user_id] : []));
}

export interface ReviewFileFacts {
  readonly name: string;
  readonly ownerUserId: string;
  readonly projectId: string;
}

/** The file a thread or decision is about: its name and the person who uploaded it. */
export async function findReviewFileFacts(
  tx: WorkerTransaction,
  organizationId: string,
  fileAssetId: string,
): Promise<ReviewFileFacts | null> {
  const rows = await tx.query<
    readonly { name: string; owner_user_id: string; project_id: string }[]
  >(
    `SELECT f.name, f.owner_user_id, f.project_id
       FROM file_assets f
      WHERE f.organization_id = ? AND f.id = ? AND f.deleted_at IS NULL`,
    [organizationId, fileAssetId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { name: row.name, ownerUserId: row.owner_user_id, projectId: row.project_id };
}
