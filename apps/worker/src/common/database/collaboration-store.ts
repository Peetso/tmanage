import { uuidv7 } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * CQ-12 — the statements the collaboration notices, the client-action mail and the automation
 * runner need. Every read is scoped to the organization the triggering event carries, and every
 * recipient is resolved from the *current* rows at delivery (`24-EVENT-CATALOG` §6): a person
 * suspended, taken off the project or out of the channel between the event and its delivery is
 * told nothing.
 */

/** An internal recipient as the reach rule needs to see them. `null` when not an active member. */
export interface InternalReach {
  readonly membershipId: string;
  readonly role: string;
  readonly hasOrgWideScope: boolean;
  readonly onProject: boolean;
}

/** One person's active internal membership and whether they are on the project. */
export async function findInternalReach(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
  projectId: string,
): Promise<InternalReach | null> {
  interface Row {
    readonly id: string;
    readonly role: string;
    readonly has_org_wide_scope: number;
    readonly on_project: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.id, m.role, m.has_org_wide_scope,
            EXISTS (
              SELECT 1 FROM project_memberships pm
               WHERE pm.organization_id = m.organization_id
                 AND pm.project_id = ?
                 AND pm.user_id = m.user_id
            ) AS on_project
       FROM memberships m
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'`,
    [projectId, organizationId, userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    membershipId: row.id,
    role: row.role,
    hasOrgWideScope: Boolean(row.has_org_wide_scope),
    onProject: Boolean(row.on_project),
  };
}

/** Whether a user is in a channel. */
export async function isConversationMember(
  tx: WorkerTransaction,
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.query<readonly { present: number }[]>(
    `SELECT EXISTS (
              SELECT 1 FROM conversation_memberships
               WHERE organization_id = ? AND conversation_id = ? AND user_id = ?
            ) AS present`,
    [organizationId, conversationId, userId],
  );
  return Boolean(rows[0]?.present);
}

/**
 * The per-kind opt-out (x152), honoured at delivery — NS-13's deferred half, for the kinds the
 * collaboration notices carry. No row means the kind is on.
 */
export async function isNotificationKindEnabled(
  tx: WorkerTransaction,
  organizationId: string,
  membershipId: string,
  kind: string,
): Promise<boolean> {
  const rows = await tx.query<readonly { enabled: number }[]>(
    `SELECT enabled FROM notification_kind_prefs
      WHERE organization_id = ? AND membership_id = ? AND kind = ?`,
    [organizationId, membershipId, kind],
  );
  const row = rows[0];
  return row === undefined ? true : Boolean(row.enabled);
}

/** The organization's slug (for links) and name (for copy). */
export async function findOrganizationFacts(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<{ readonly slug: string; readonly name: string } | null> {
  const rows = await tx.query<readonly { slug: string; name: string }[]>(
    `SELECT slug, name FROM organizations WHERE id = ?`,
    [organizationId],
  );
  return rows[0] ?? null;
}

/** A person's display name, or null when the user row is gone. */
export async function findDisplayName(
  tx: WorkerTransaction,
  userId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { display_name: string }[]>(
    `SELECT display_name FROM users WHERE id = ?`,
    [userId],
  );
  return rows[0]?.display_name ?? null;
}

export async function findProjectName(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { name: string }[]>(
    `SELECT name FROM projects WHERE organization_id = ? AND id = ?`,
    [organizationId, projectId],
  );
  return rows[0]?.name ?? null;
}

/** NT1 — what a request-message notice names: the request's title and who filed it. */
export interface ClientRequestFacts {
  readonly title: string;
  readonly submittedByUserId: string;
}

/** The request a message was posted on, or null when the row is gone. Never the message body. */
export async function findClientRequestFacts(
  tx: WorkerTransaction,
  organizationId: string,
  requestId: string,
): Promise<ClientRequestFacts | null> {
  const rows = await tx.query<readonly { title: string; submitted_by_user_id: string }[]>(
    `SELECT title, submitted_by_user_id FROM client_requests
      WHERE organization_id = ? AND id = ?`,
    [organizationId, requestId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { title: row.title, submittedByUserId: row.submitted_by_user_id };
}

/**
 * NT1 — the display name behind a message author's membership: a client membership for a client
 * author, an internal one otherwise. Null when the membership or the user row is gone.
 */
export async function findMembershipDisplayName(
  tx: WorkerTransaction,
  organizationId: string,
  membershipId: string,
  kind: 'internal' | 'client',
): Promise<string | null> {
  const sql =
    kind === 'client'
      ? `SELECT u.display_name
           FROM client_memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ? AND m.id = ?`
      : `SELECT u.display_name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ? AND m.id = ?`;
  const rows = await tx.query<readonly { display_name: string }[]>(sql, [
    organizationId,
    membershipId,
  ]);
  return rows[0]?.display_name ?? null;
}

export async function findConversationFacts(
  tx: WorkerTransaction,
  organizationId: string,
  conversationId: string,
): Promise<{ readonly name: string; readonly projectId: string } | null> {
  const rows = await tx.query<readonly { name: string; project_id: string }[]>(
    `SELECT name, project_id FROM conversations
      WHERE organization_id = ? AND id = ? AND archived_at IS NULL`,
    [organizationId, conversationId],
  );
  const row = rows[0];
  return row === undefined ? null : { name: row.name, projectId: row.project_id };
}

export async function findDocumentFacts(
  tx: WorkerTransaction,
  organizationId: string,
  documentId: string,
): Promise<{
  readonly title: string;
  readonly projectId: string;
  readonly createdByUserId: string;
} | null> {
  interface Row {
    readonly title: string;
    readonly project_id: string;
    readonly created_by_user_id: string;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT title, project_id, created_by_user_id FROM documents
      WHERE organization_id = ? AND id = ?`,
    [organizationId, documentId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { title: row.title, projectId: row.project_id, createdByUserId: row.created_by_user_id };
}

export async function findMeetingFacts(
  tx: WorkerTransaction,
  organizationId: string,
  meetingId: string,
): Promise<{
  readonly title: string;
  readonly projectId: string;
  readonly startsAt: Date;
  readonly createdByUserId: string;
} | null> {
  interface Row {
    readonly title: string;
    readonly project_id: string;
    readonly starts_at: Date | string;
    readonly created_by_user_id: string;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT title, project_id, starts_at, created_by_user_id FROM meetings
      WHERE organization_id = ? AND id = ?`,
    [organizationId, meetingId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        title: row.title,
        projectId: row.project_id,
        startsAt: row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at),
        createdByUserId: row.created_by_user_id,
      };
}

export async function findWorkItemFacts(
  tx: WorkerTransaction,
  organizationId: string,
  workItemId: string,
): Promise<{
  readonly title: string;
  readonly projectId: string;
  readonly ownerUserId: string | null;
  readonly audience: string;
} | null> {
  interface Row {
    readonly title: string;
    readonly project_id: string;
    readonly owner_user_id: string | null;
    readonly audience: string;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT title, project_id, owner_user_id, audience FROM work_items
      WHERE organization_id = ? AND id = ?`,
    [organizationId, workItemId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        title: row.title,
        projectId: row.project_id,
        ownerUserId: row.owner_user_id,
        audience: row.audience,
      };
}

/** The project's managers — the people a request on it is owned by. */
export async function listProjectManagerIds(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { user_id: string }[]>(
    `SELECT pm.user_id FROM project_memberships pm
      WHERE pm.organization_id = ? AND pm.project_id = ? AND pm.role IN ('manager', 'owner')
      ORDER BY pm.id`,
    [organizationId, projectId],
  );
  return rows.map((row) => row.user_id);
}

/** The project's owner of record (`projects.owner_user_id`), if any. */
export async function findProjectOwnerId(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { owner_user_id: string | null }[]>(
    `SELECT owner_user_id FROM projects WHERE organization_id = ? AND id = ?`,
    [organizationId, projectId],
  );
  return rows[0]?.owner_user_id ?? null;
}

/** A client person who may be asked to act on a project's shared work. */
export interface ClientActionCandidate {
  readonly userId: string;
  readonly role: string;
}

/**
 * Every client person with an active, unexpired client membership in a client organization the
 * project is shared with. The role half (who may decide) is the consumer's, from the domain.
 */
export async function listProjectClientPeople(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<readonly ClientActionCandidate[]> {
  const rows = await tx.query<readonly { user_id: string; role: string }[]>(
    `SELECT DISTINCT cm.user_id, cm.role
       FROM client_memberships cm
       JOIN project_clients pc
         ON pc.organization_id = cm.organization_id
        AND pc.client_organization_id = cm.client_organization_id
      WHERE cm.organization_id = ?
        AND pc.project_id = ?
        AND cm.status = 'active'
        AND (cm.expires_at IS NULL OR cm.expires_at > NOW(3))`,
    [organizationId, projectId],
  );
  return rows.map((row) => ({ userId: row.user_id, role: row.role }));
}

/** An enabled automation rule, as the runner needs it. */
export interface AutomationRule {
  readonly id: string;
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
}

export async function listEnabledRulesForTrigger(
  tx: WorkerTransaction,
  organizationId: string,
  triggerKind: string,
): Promise<readonly AutomationRule[]> {
  interface Row {
    readonly id: string;
    readonly name: string;
    readonly trigger_kind: string;
    readonly action_kind: string;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT id, name, trigger_kind, action_kind FROM workflow_templates
      WHERE organization_id = ? AND trigger_kind = ? AND enabled = 1
      ORDER BY id`,
    [organizationId, triggerKind],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    triggerKind: row.trigger_kind,
    actionKind: row.action_kind,
  }));
}

/** Append one run to a rule's history — the same row a manual run writes. */
export async function insertWorkflowRun(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly templateId: string;
    readonly status: 'succeeded' | 'failed';
    readonly detail: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO workflow_runs
       (id, organization_id, template_id, status, detail_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [uuidv7(), input.organizationId, input.templateId, input.status, JSON.stringify(input.detail)],
  );
}
