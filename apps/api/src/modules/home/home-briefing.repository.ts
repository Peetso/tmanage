import { BRIEFING_SIGNAL_LIMIT, briefingSubjectKey, isSignalRuleKey } from '@tmanage/domain';
import type { BriefingSubject, OpenSignal, SignalSubjectType } from '@tmanage/domain';
import type {
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 62-A1b (B11) — the reads behind the Home business briefing, as the app role. Bound SQL, the
 * organization from the verified context on every table of every statement; nothing reads the
 * database clock (the sweep's own stamp is the "as of").
 *
 * - {@link lastSweep}: `work_signal_sweeps`, the last finished sweep of this company.
 * - {@link openSignals}: the `work_signals` that sweep still found (`seen_at` at or after it).
 * - {@link team}: the memberships on the projects the viewer leads, and the people reporting to
 *   them (`project_memberships`, `memberships`, `member_reporting_lines`).
 * - {@link subjects}: each signal's record, resolved only while it is live (work item not deleted,
 *   project not archived, membership active), so a line that cannot be opened is never counted.
 *
 * Grants (app role): SELECT on `work_signal_sweeps`, `work_signals`, `work_items`, `projects`,
 * `memberships`, `users`, `project_memberships`, `member_reporting_lines`, `client_invoices`,
 * `client_organizations`, `expenses`, `approvals`, `deliverables`.
 */

export const HOME_BRIEFING_SQL = {
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

const NO_SUBJECT: BriefingSubject = {
  title: null,
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
};

/** How one subject type's rows read into a subject. */
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

export class HomeBriefingRepository {
  async lastSweep(runner: TenantQueryRunner, context: TenantContext): Promise<Date | null> {
    const rows = await runner.execute<QueryRows>(HOME_BRIEFING_SQL.lastSweep, [
      context.organizationId,
    ]);
    const value: unknown = rows[0]?.['swept_at'];
    if (value === undefined || value === null) return null;
    return value instanceof Date ? value : new Date(String(value));
  }

  async openSignals(
    runner: TenantQueryRunner,
    context: TenantContext,
    sweptAt: Date,
  ): Promise<readonly OpenSignal[]> {
    const rows = await runner.execute<QueryRows>(HOME_BRIEFING_SQL.openSignals, [
      context.organizationId,
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
  }

  /** The memberships on the given projects, and the people reporting to `membershipId`. */
  async team(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
    membershipId: string,
  ): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    if (projectIds.length > 0) {
      const rows = await runner.execute<QueryRows>(
        HOME_BRIEFING_SQL.teamOnProjects(projectIds.length),
        [context.organizationId, ...projectIds],
      );
      for (const row of rows) ids.add(String(row['id']));
    }
    const reports = await runner.execute<QueryRows>(HOME_BRIEFING_SQL.reports, [
      context.organizationId,
      membershipId,
    ]);
    for (const row of reports) ids.add(String(row['member_id']));
    return ids;
  }

  /** Each signal's live record, keyed by {@link briefingSubjectKey}; a missing key = not openable. */
  async subjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    signals: readonly OpenSignal[],
  ): Promise<ReadonlyMap<string, BriefingSubject>> {
    const resolved = new Map<string, BriefingSubject>();
    for (const type of SUBJECT_TYPES) {
      const ids = [
        ...new Set(signals.filter((s) => s.subjectType === type).map((s) => s.subjectId)),
      ];
      if (ids.length === 0) continue;
      const params: SqlParameter[] = [context.organizationId, ...ids];
      const rows = await runner.execute<QueryRows>(HOME_BRIEFING_SQL[type](ids.length), params);
      for (const row of rows) {
        resolved.set(briefingSubjectKey(type, String(row['id'])), SUBJECT_OF[type](row));
      }
    }
    return resolved;
  }
}
