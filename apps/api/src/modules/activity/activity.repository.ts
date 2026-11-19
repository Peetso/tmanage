import { AUDIENCES, type ActivityKind, type ActivitySource, type Audience } from '@tmanage/domain';
import type {
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 62-A2 (B02) — the activity read repository: entries of `activity_entries` (0379) for one project
 * or one client, and the current state of the source rows they point at.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6, as every repository here: the runner and the
 * context come first, the tenant predicate (`organization_id = context.organizationId`) is on every
 * statement and every value is bound. The table is written only by the worker's projector; this
 * class has no write. Statements go through `query` (LIMIT and IN lists are bound values).
 *
 * The source reads ({@link SOURCE_FACTS_SQL}) return what a read rule needs — project, client,
 * audience — for the rows that still exist, plus the row's name as it is now (`subject`: a task's
 * title, a file's name, an invoice's number; D2), joined at read time, never stored on the entry.
 * A deleted row is simply absent, and the service drops its entries. Never a body or an amount.
 */

export interface ActivityEntryRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly kind: string;
  readonly actorUserId: string | null;
  readonly occurredAt: Date;
}

/** Keyset position, newest first: entries strictly older than this one. */
export interface ActivityKey {
  readonly occurredAt: Date;
  readonly id: string;
}

export interface ActivityFilter {
  readonly kind?: ActivityKind;
  readonly actorUserId?: string;
  /** Inclusive lower bound on `occurred_at`. */
  readonly from?: Date;
  /** Exclusive upper bound on `occurred_at`. */
  readonly to?: Date;
}

/** Which entries a feed covers: one project, or one client and the projects shared with it. */
export type ActivityScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'client';
      readonly clientOrganizationId: string;
      readonly projectIds: readonly string[];
    };

/** What a source row's read rule needs, for a row that still exists, and its current name. */
export interface ActivitySourceFacts {
  readonly id: string;
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  readonly audience: Audience;
  /** The row's name now; `null` for a source without one (an expense) or an unnumbered draft. */
  readonly subject: string | null;
}

/** The fact sources: a membership entry is read through its project's row. */
export type FactSource = Exclude<ActivitySource, 'project_membership'>;

/**
 * Per source: `[organizationId, ...ids]` → `id, project_id, client_organization_id, audience,
 * subject`. The subject is only ever returned with the facts that gate it: the service shows it on
 * an entry the viewer may read, and drops the entry (name and all) otherwise.
 */
export const SOURCE_FACTS_SQL: Readonly<Record<FactSource, (ids: number) => string>> = {
  project: (n) => `select p.id as id, p.id as project_id, null as client_organization_id,
      'internal' as audience, p.name as subject
    from projects p where p.organization_id = ? and p.id in (${marks(n)})`,
  work_item: (n) => `select w.id as id, w.project_id as project_id,
      null as client_organization_id, w.audience as audience, w.title as subject
    from work_items w
    where w.organization_id = ? and w.id in (${marks(n)}) and w.deleted_at is null`,
  time_log: (n) => `select t.id as id, w.project_id as project_id,
      null as client_organization_id, w.audience as audience, w.title as subject
    from work_item_time_logs t
    join work_items w on w.organization_id = t.organization_id and w.id = t.work_item_id
    where t.organization_id = ? and t.id in (${marks(n)}) and w.deleted_at is null`,
  file_asset: (n) => `select f.id as id, f.project_id as project_id,
      f.client_organization_id as client_organization_id, f.audience as audience,
      f.name as subject
    from file_assets f
    where f.organization_id = ? and f.id in (${marks(n)}) and f.deleted_at is null`,
  deliverable: (n) => `select d.id as id, d.project_id as project_id,
      null as client_organization_id, 'client_visible' as audience, d.title as subject
    from deliverables d
    where d.organization_id = ? and d.id in (${marks(n)}) and d.deleted_at is null`,
  approval: (n) => `select a.id as id, a.project_id as project_id,
      null as client_organization_id, 'client_visible' as audience, d.title as subject
    from approvals a
    left join deliverables d on d.organization_id = a.organization_id and d.id = a.deliverable_id
      and d.deleted_at is null
    where a.organization_id = ? and a.id in (${marks(n)})`,
  project_milestone: (n) => `select m.id as id, m.project_id as project_id,
      null as client_organization_id, 'internal' as audience, m.title as subject
    from project_milestones m where m.organization_id = ? and m.id in (${marks(n)})`,
  client_request: (n) => `select r.id as id, r.project_id as project_id,
      r.client_organization_id as client_organization_id, 'client_visible' as audience,
      r.title as subject
    from client_requests r where r.organization_id = ? and r.id in (${marks(n)})`,
  client_invoice: (n) => `select i.id as id, i.project_id as project_id,
      i.client_organization_id as client_organization_id, 'internal' as audience,
      i.number as subject
    from client_invoices i where i.organization_id = ? and i.id in (${marks(n)})`,
  quote: (n) => `select q.id as id, q.converted_project_id as project_id,
      q.client_organization_id as client_organization_id, 'internal' as audience,
      q.number as subject
    from quotes q where q.organization_id = ? and q.id in (${marks(n)})`,
  expense: (n) => `select e.id as id, e.project_id as project_id,
      e.client_organization_id as client_organization_id, 'internal' as audience,
      null as subject
    from expenses e where e.organization_id = ? and e.id in (${marks(n)})`,
};

const ENTRY_COLUMNS = `a.id as id, a.project_id as project_id,
  a.client_organization_id as client_organization_id, a.object_type as object_type,
  a.object_id as object_id, a.action as action, a.kind as kind, a.actor_user_id as actor_user_id,
  a.occurred_at as occurred_at`;

function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function audienceOf(value: unknown): Audience {
  return (AUDIENCES as readonly unknown[]).includes(value) ? (value as Audience) : 'internal';
}

function toEntry(row: QueryRows[number]): ActivityEntryRow {
  const occurredAt = row['occurred_at'];
  return {
    id: String(row['id']),
    projectId: str(row['project_id']),
    clientOrganizationId: str(row['client_organization_id']),
    objectType: String(row['object_type']),
    objectId: String(row['object_id']),
    action: String(row['action']),
    kind: String(row['kind']),
    actorUserId: str(row['actor_user_id']),
    occurredAt: occurredAt instanceof Date ? occurredAt : new Date(String(occurredAt)),
  };
}

export class ActivityRepository {
  /**
   * One page of a feed, newest first (`occurred_at desc, id desc`), strictly after `before`.
   * A client feed with no shared project reads only the entries that name the client.
   */
  async listEntries(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: ActivityScope,
    filter: ActivityFilter,
    before: ActivityKey | null,
    limit: number,
  ): Promise<readonly ActivityEntryRow[]> {
    const where: string[] = ['a.organization_id = ?'];
    const params: SqlParameter[] = [context.organizationId];
    if (scope.kind === 'project') {
      where.push('a.project_id = ?');
      params.push(scope.projectId);
    } else if (scope.projectIds.length === 0) {
      where.push('a.client_organization_id = ?');
      params.push(scope.clientOrganizationId);
    } else {
      where.push(
        `(a.client_organization_id = ? or a.project_id in (${marks(scope.projectIds.length)}))`,
      );
      params.push(scope.clientOrganizationId, ...scope.projectIds);
    }
    if (filter.kind !== undefined) {
      where.push('a.kind = ?');
      params.push(filter.kind);
    }
    if (filter.actorUserId !== undefined) {
      where.push('a.actor_user_id = ?');
      params.push(filter.actorUserId);
    }
    if (filter.from !== undefined) {
      where.push('a.occurred_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('a.occurred_at < ?');
      params.push(filter.to);
    }
    if (before !== null) {
      where.push('(a.occurred_at < ? or (a.occurred_at = ? and a.id < ?))');
      params.push(before.occurredAt, before.occurredAt, before.id);
    }
    params.push(limit);
    const rows = await runner.query<QueryRows>(
      `select ${ENTRY_COLUMNS} from activity_entries a where ${where.join(' and ')}
       order by a.occurred_at desc, a.id desc limit ?`,
      params,
    );
    return rows.map(toEntry);
  }

  /** The source rows among `ids` that still exist, keyed by id. An empty list reads nothing. */
  async sourceFacts(
    runner: TenantQueryRunner,
    context: TenantContext,
    source: FactSource,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ActivitySourceFacts>> {
    if (ids.length === 0) return new Map();
    const rows = await runner.query<QueryRows>(SOURCE_FACTS_SQL[source](ids.length), [
      context.organizationId,
      ...ids,
    ]);
    return new Map(
      rows.map((row) => {
        const facts: ActivitySourceFacts = {
          id: String(row['id']),
          projectId: str(row['project_id']),
          clientOrganizationId: str(row['client_organization_id']),
          audience: audienceOf(row['audience']),
          subject: str(row['subject']),
        };
        return [facts.id, facts] as const;
      }),
    );
  }
}
