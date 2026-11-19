import {
  BRIEFING_SIGNAL_LIMIT,
  CAPABILITIES,
  assembleBriefing,
  briefingSubjectKey,
  briefingViewerBase,
  effectiveCapabilitySet,
  isSignalRuleKey,
} from '@tmanage/domain';
import type {
  Briefing,
  BriefingSource,
  BriefingSubject,
  BriefingViewerBase,
  Capability,
  OpenSignal,
  PermissionOverrides,
  SignalSubjectType,
} from '@tmanage/domain';
import { CUSTOM_ROLE_COLUMNS, customRoleJoin, internalPrincipalRole } from './principal-role.js';
import type { CustomRoleColumns } from './principal-role.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 62-A1c (B12) — one person's business briefing as the worker reads it for the digest mail: the
 * same viewer (domain `briefingViewerBase`), the same read order (domain `assembleBriefing`) and
 * the same grouping (domain `buildBriefing`) as the Home card, so the mail section lists exactly
 * the card's lines for the same person.
 *
 * The briefing reads ({@link BRIEFING_SQL} down to `approval`) are copied verbatim from the API's
 * `apps/api/src/modules/home/home-briefing.repository.ts` (one app may not import another's
 * `src/`; `finance-facts-store.ts` does the same). Change both together. The viewer reads mirror
 * the API's principal: `membership-resolver.repository.ts` (role, custom role, org-wide scope),
 * `membership-overrides.repository.ts` (live overrides, here against a bound clock, never the
 * database's) and `principal.repository.ts` `projectScope` (workspace admin = the workspace's
 * projects, anyone else = their project memberships).
 *
 * Grants (worker role, B12 WIRING): SELECT on `work_signal_sweeps`, `work_signals`, `work_items`,
 * `projects`, `memberships`, `users`, `project_memberships`, `member_reporting_lines`,
 * `client_invoices`, `client_organizations`, `expenses`, `approvals`, `deliverables`,
 * `custom_roles`, `membership_permission_overrides`.
 */

export const BRIEFING_SQL = {
  // ── Copied from home-briefing.repository.ts ─────────────────────────────
  lastSweep: `SELECT swept_at FROM work_signal_sweeps WHERE organization_id = ?`,
  openSignals: `SELECT id, rule_key, subject_type, subject_id, project_id, measure, threshold
  FROM work_signals
 WHERE organization_id = ? AND seen_at >= ?
 ORDER BY id
 LIMIT ?`,
  teamOnProjects: (projects: number) => `SELECT DISTINCT m.id
  FROM project_memberships pm
  JOIN memberships m ON m.organization_id = pm.organization_id AND m.user_id = pm.user_id
 WHERE pm.organization_id = ? AND m.status = 'active' AND pm.project_id IN (${marks(projects)})`,
  reports: `SELECT r.member_id FROM member_reporting_lines r
 WHERE r.organization_id = ? AND r.manager_member_id = ?`,
  work_item: (ids: number) => `SELECT x.id, x.title, p.name AS project_name
  FROM work_items x
  JOIN projects p ON p.organization_id = x.organization_id AND p.id = x.project_id
        AND p.archived_at IS NULL
 WHERE x.organization_id = ? AND x.deleted_at IS NULL AND x.id IN (${marks(ids)})`,
  membership: (ids: number) => `SELECT m.id, u.display_name
  FROM memberships m
  JOIN users u ON u.id = m.user_id
 WHERE m.organization_id = ? AND m.status = 'active' AND m.id IN (${marks(ids)})`,
  client_invoice: (ids: number) => `SELECT i.id, i.number, i.total_minor, i.paid_minor, i.currency,
       c.name AS client_name
  FROM client_invoices i
  LEFT JOIN client_organizations c
         ON c.organization_id = i.organization_id AND c.id = i.client_organization_id
 WHERE i.organization_id = ? AND i.id IN (${marks(ids)})`,
  project: (ids: number) => `SELECT p.id, p.name FROM projects p
 WHERE p.organization_id = ? AND p.archived_at IS NULL AND p.id IN (${marks(ids)})`,
  expense: (ids: number) => `SELECT e.id, e.note, e.category, e.amount_minor, e.currency,
       p.name AS project_name
  FROM expenses e
  LEFT JOIN projects p ON p.organization_id = e.organization_id AND p.id = e.project_id
 WHERE e.organization_id = ? AND e.id IN (${marks(ids)})`,
  approval: (ids: number) => `SELECT a.id, a.deliverable_id, d.title, p.name AS project_name
  FROM approvals a
  JOIN deliverables d ON d.organization_id = a.organization_id AND d.id = a.deliverable_id
  JOIN projects p ON p.organization_id = a.organization_id AND p.id = a.project_id
        AND p.archived_at IS NULL
 WHERE a.organization_id = ? AND a.id IN (${marks(ids)})`,
  // ── The viewer, as the API's principal resolves it ──────────────────────
  member: `SELECT m.id, m.user_id, m.role, ${CUSTOM_ROLE_COLUMNS},
       m.has_org_wide_scope, m.workspace_scope_id
  FROM memberships m
  ${customRoleJoin('m')}
 WHERE m.organization_id = ? AND m.id = ? AND m.status = 'active'`,
  overrides: `SELECT o.capability, o.effect FROM membership_permission_overrides o
 WHERE o.organization_id = ? AND o.membership_id = ? AND o.audience = 'internal'
   AND o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > ?)
 ORDER BY o.capability`,
  workspaceProjects: `SELECT p.id FROM projects p
 WHERE p.organization_id = ? AND p.workspace_id = ?
 ORDER BY p.id`,
  memberProjects: `SELECT pm.project_id FROM project_memberships pm
 WHERE pm.organization_id = ? AND pm.user_id = ?
 ORDER BY pm.project_id`,
} as const;

function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

type Row = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const whole = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const flag = (value: unknown): boolean => value === true || Number(value) === 1;

const NO_SUBJECT: BriefingSubject = {
  title: null,
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
};

/** How one subject type's rows read into a subject (as in the API repository). */
const SUBJECT_OF: Readonly<Record<SignalSubjectType, (row: Row) => BriefingSubject>> = {
  work_item: (row) => ({
    ...NO_SUBJECT,
    title: text(row['title']),
    context: text(row['project_name']),
  }),
  membership: (row) => ({ ...NO_SUBJECT, title: text(row['display_name']) }),
  client_invoice: (row) => ({
    ...NO_SUBJECT,
    title: text(row['number']),
    context: text(row['client_name']),
    amount: {
      minor: Math.max(0, whole(row['total_minor']) - whole(row['paid_minor'])),
      currency: String(row['currency']),
    },
  }),
  project: (row) => ({ ...NO_SUBJECT, title: text(row['name']) }),
  expense: (row) => ({
    ...NO_SUBJECT,
    title: text(row['note']),
    context: text(row['project_name']),
    category: text(row['category']),
    amount: { minor: whole(row['amount_minor']), currency: String(row['currency']) },
  }),
  approval: (row) => ({
    ...NO_SUBJECT,
    title: text(row['title']),
    context: text(row['project_name']),
    deliverableId: text(row['deliverable_id']),
  }),
};

const SUBJECT_TYPES = Object.keys(SUBJECT_OF) as SignalSubjectType[];

function isSubjectType(value: unknown): value is SignalSubjectType {
  return typeof value === 'string' && (SUBJECT_TYPES as readonly string[]).includes(value);
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITIES);

/** Override rows as the domain reads them; an unknown capability is dropped (as the API does). */
function overridesOf(rows: readonly Row[]): PermissionOverrides {
  const allow: Capability[] = [];
  const deny: Capability[] = [];
  for (const row of rows) {
    const capability = String(row['capability']);
    if (!KNOWN_CAPABILITIES.has(capability)) continue;
    if (row['effect'] === 'allow') allow.push(capability as Capability);
    else if (row['effect'] === 'deny') deny.push(capability as Capability);
  }
  return { allow, deny };
}

/** The briefing reads bound to one company, inside the caller's transaction. */
export function briefingSourceOf(tx: WorkerTransaction, organizationId: string): BriefingSource {
  return {
    async team(projectIds, membershipId) {
      const ids = new Set<string>();
      if (projectIds.length > 0) {
        const rows = await tx.query<readonly Row[]>(
          BRIEFING_SQL.teamOnProjects(projectIds.length),
          [organizationId, ...projectIds],
        );
        for (const row of rows) ids.add(String(row['id']));
      }
      const reports = await tx.query<readonly Row[]>(BRIEFING_SQL.reports, [
        organizationId,
        membershipId,
      ]);
      for (const row of reports) ids.add(String(row['member_id']));
      return ids;
    },

    async lastSweep() {
      const rows = await tx.query<readonly Row[]>(BRIEFING_SQL.lastSweep, [organizationId]);
      const value: unknown = rows[0]?.['swept_at'];
      if (value === undefined || value === null) return null;
      return value instanceof Date ? value : new Date(String(value));
    },

    async openSignals(sweptAt) {
      const rows = await tx.query<readonly Row[]>(BRIEFING_SQL.openSignals, [
        organizationId,
        sweptAt,
        BRIEFING_SIGNAL_LIMIT,
      ]);
      return rows.flatMap((row): OpenSignal[] => {
        const rule: unknown = row['rule_key'];
        const subjectType: unknown = row['subject_type'];
        if (!isSignalRuleKey(rule) || !isSubjectType(subjectType)) return [];
        return [
          {
            signalId: String(row['id']),
            rule,
            subjectType,
            subjectId: String(row['subject_id']),
            projectId: row['project_id'] === null ? null : String(row['project_id']),
            measure: whole(row['measure']),
            threshold: whole(row['threshold']),
          },
        ];
      });
    },

    async subjects(signals) {
      const resolved = new Map<string, BriefingSubject>();
      for (const type of SUBJECT_TYPES) {
        const ids = [
          ...new Set(signals.filter((s) => s.subjectType === type).map((s) => s.subjectId)),
        ];
        if (ids.length === 0) continue;
        const rows = await tx.query<readonly Row[]>(BRIEFING_SQL[type](ids.length), [
          organizationId,
          ...ids,
        ]);
        for (const row of rows) {
          resolved.set(briefingSubjectKey(type, String(row['id'])), SUBJECT_OF[type](row));
        }
      }
      return resolved;
    },
  };
}

/**
 * The member as the briefing's viewer, or null when they may have none: not an active internal
 * membership, a role that holds nothing, or a guest (the card's 404).
 */
export async function findBriefingViewer(
  tx: WorkerTransaction,
  organizationId: string,
  membershipId: string,
  now: Date,
): Promise<BriefingViewerBase | null> {
  const row = (
    await tx.query<readonly (Row & CustomRoleColumns)[]>(BRIEFING_SQL.member, [
      organizationId,
      membershipId,
    ])
  )[0];
  if (row === undefined) return null;
  const role = internalPrincipalRole(row['role'] as string, row);
  if (role === null || role === 'guest') return null;
  const overrides = overridesOf(
    await tx.query<readonly Row[]>(BRIEFING_SQL.overrides, [organizationId, membershipId, now]),
  );
  const holds = effectiveCapabilitySet({ role, overrides });
  const hasOrgWideScope = flag(row['has_org_wide_scope']);
  const workspace = text(row['workspace_scope_id']);
  const projectIds = hasOrgWideScope
    ? []
    : workspace !== null
      ? (
          await tx.query<readonly Row[]>(BRIEFING_SQL.workspaceProjects, [
            organizationId,
            workspace,
          ])
        ).map((project) => String(project['id']))
      : (
          await tx.query<readonly Row[]>(BRIEFING_SQL.memberProjects, [
            organizationId,
            String(row['user_id']),
          ])
        ).map((project) => String(project['project_id']));
  return briefingViewerBase({
    hasOrgWideScope,
    holds: (capability) => holds.has(capability),
    projectIds,
    membershipId,
  });
}

/** One member's briefing (the card's for the same person), or null when they have none. */
export async function readBriefing(
  tx: WorkerTransaction,
  organizationId: string,
  membershipId: string,
  now: Date,
): Promise<Briefing | null> {
  const viewer = await findBriefingViewer(tx, organizationId, membershipId, now);
  if (viewer === null) return null;
  return assembleBriefing(briefingSourceOf(tx, organizationId), viewer);
}
