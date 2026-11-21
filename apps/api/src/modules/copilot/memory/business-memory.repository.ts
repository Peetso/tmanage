import type { ResultSetHeader } from 'mysql2';
import type {
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type {
  BusinessFact,
  BusinessFactAudience,
  BusinessFactEntityType,
  BusinessFactStatus,
  EntityRef,
  FactReadScope,
} from './business-memory.js';

/**
 * 62-26 (0395) — `business_facts`. Bound SQL only; the organization from the verified context on
 * every statement; the times bound by the service (never the database clock). The read filter
 * ({@link scopeClause}) is the SQL twin of `mayReadFact` and runs before ordering and the limit.
 */

const COLUMNS = `id, entity_type, entity_id, fact, category, source_href, audience, status,
  proposed_via, owner_user_id, proposed_by_user_id, approved_by_user_id, approved_at,
  last_confirmed_at, retired_at, created_at, updated_at`;

const date = (value: unknown): Date | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value
      : new Date(String(value));

function factOf(row: Record<string, unknown>): BusinessFact {
  return {
    id: String(row['id']),
    entityType: String(row['entity_type']) as BusinessFactEntityType,
    entityId: row['entity_id'] === null ? null : String(row['entity_id']),
    fact: String(row['fact']),
    category: String(row['category']),
    sourceHref: row['source_href'] === null ? null : String(row['source_href']),
    audience: String(row['audience']) as BusinessFactAudience,
    status: String(row['status']) as BusinessFactStatus,
    proposedVia: row['proposed_via'] === 'ai' ? 'ai' : 'member',
    ownerUserId: String(row['owner_user_id']),
    proposedByUserId: String(row['proposed_by_user_id']),
    approvedByUserId:
      row['approved_by_user_id'] === null ? null : String(row['approved_by_user_id']),
    approvedAt: date(row['approved_at']),
    lastConfirmedAt: date(row['last_confirmed_at']),
    retiredAt: date(row['retired_at']),
    createdAt: date(row['created_at'])!,
    updatedAt: date(row['updated_at'])!,
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** `col IN (…)`, or a false predicate for an empty list (never `IN ()`). */
function inList(column: string, values: readonly string[], params: SqlParameter[]): string {
  if (values.length === 0) return '0 = 1';
  params.push(...values);
  return `${column} IN (${placeholders(values.length)})`;
}

/** The read filter: audience, then the entities the reader's scope reaches. */
export function scopeClause(scope: FactReadScope, params: SqlParameter[]): string {
  if (!scope.internal) return '0 = 1';
  const parts = [inList('audience', scope.audiences, params)];
  if (!scope.orgWide) {
    const reach = [
      `(entity_type = 'project' AND ${inList('entity_id', [...scope.projectIds], params)})`,
      `(entity_type = 'client' AND ${inList('entity_id', [...scope.clientIds], params)})`,
      ...(scope.orgLevel ? ["entity_type IN ('person', 'process', 'company')"] : []),
    ];
    parts.push(`(${reach.join(' OR ')})`);
  }
  return parts.join(' AND ');
}

export interface FactListFilter {
  /** `null` = every status the caller may see. */
  readonly statuses: readonly BusinessFactStatus[];
  /** Proposed facts of others are hidden unless the caller approves (`ai.manage`). */
  readonly ownProposalsOnly: string | null;
  readonly entityType?: BusinessFactEntityType;
  readonly entityId?: string;
  readonly staleBefore?: Date;
  readonly limit: number;
}

export interface NewFact {
  readonly id: string;
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: string;
  readonly sourceHref: string | null;
  readonly audience: BusinessFactAudience;
  readonly proposedVia: 'ai' | 'member';
  readonly ownerUserId: string;
  readonly proposedByUserId: string;
  readonly at: Date;
}

export interface FactChange {
  readonly fact?: string;
  readonly category?: string;
  readonly sourceHref?: string | null;
  readonly audience?: BusinessFactAudience;
  readonly ownerUserId?: string;
}

const changed = (result: ResultSetHeader): boolean => result.affectedRows === 1;

export class BusinessMemoryRepository {
  /** The clients of the given projects (the client facts a project member may read). */
  async clientIdsOfProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly string[]> {
    if (projectIds.length === 0) return [];
    const rows = await runner.execute<QueryRows>(
      `SELECT DISTINCT client_organization_id FROM project_clients
        WHERE organization_id = ? AND project_id IN (${placeholders(projectIds.length)})`,
      [context.organizationId, ...projectIds],
    );
    return rows.map((row) => String(row['client_organization_id']));
  }

  /** Does the record a fact would be about exist in this workspace? */
  async entityExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    type: BusinessFactEntityType,
    id: string,
  ): Promise<boolean> {
    const sql =
      type === 'project'
        ? 'SELECT id FROM projects WHERE organization_id = ? AND id = ? LIMIT 1'
        : type === 'client'
          ? 'SELECT id FROM client_organizations WHERE organization_id = ? AND id = ? LIMIT 1'
          : "SELECT id FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1";
    const rows = await runner.execute<QueryRows>(sql, [context.organizationId, id]);
    return rows.length > 0;
  }

  async isActiveMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<boolean> {
    return this.entityExists(runner, context, 'person', userId);
  }

  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<BusinessFact | null> {
    const rows = await runner.execute<QueryRows>(
      `SELECT ${COLUMNS} FROM business_facts WHERE organization_id = ? AND id = ? LIMIT 1${
        options.forUpdate === true ? ' FOR UPDATE' : ''
      }`,
      [context.organizationId, id],
    );
    return rows.length === 0 ? null : factOf(rows[0]!);
  }

  /** A live fact with the same text about the same entity (a repeated proposal). */
  async findDuplicate(
    runner: TenantQueryRunner,
    context: TenantContext,
    fact: Pick<NewFact, 'entityType' | 'entityId' | 'fact'>,
  ): Promise<string | null> {
    const rows = await runner.execute<QueryRows>(
      `SELECT id FROM business_facts
        WHERE organization_id = ? AND status IN ('proposed', 'approved') AND entity_type = ?
          AND ${fact.entityId === null ? 'entity_id IS NULL' : 'entity_id = ?'} AND fact = ?
        LIMIT 1`,
      [
        context.organizationId,
        fact.entityType,
        ...(fact.entityId === null ? [] : [fact.entityId]),
        fact.fact,
      ],
    );
    return rows.length === 0 ? null : String(rows[0]!['id']);
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: FactReadScope,
    filter: FactListFilter,
  ): Promise<readonly BusinessFact[]> {
    const params: SqlParameter[] = [context.organizationId];
    const where = ['organization_id = ?'];
    where.push(inList('status', filter.statuses, params));
    if (filter.ownProposalsOnly !== null) {
      where.push("(status <> 'proposed' OR proposed_by_user_id = ?)");
      params.push(filter.ownProposalsOnly);
    }
    if (filter.entityType !== undefined) {
      where.push('entity_type = ?');
      params.push(filter.entityType);
    }
    if (filter.entityId !== undefined) {
      where.push('entity_id = ?');
      params.push(filter.entityId);
    }
    if (filter.staleBefore !== undefined) {
      where.push("status = 'approved' AND last_confirmed_at <= ?");
      params.push(filter.staleBefore);
    }
    where.push(scopeClause(scope, params));
    params.push(filter.limit);
    const rows = await runner.execute<QueryRows>(
      `SELECT ${COLUMNS} FROM business_facts WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map(factOf);
  }

  /**
   * The AI recall: approved facts about the named entities, readable by the scope, the most
   * recently confirmed first, at most `limit`.
   */
  async recall(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: FactReadScope,
    entities: readonly EntityRef[],
    limit: number,
  ): Promise<readonly BusinessFact[]> {
    if (entities.length === 0) return [];
    const params: SqlParameter[] = [context.organizationId];
    const named = entities.map((ref) => {
      params.push(ref.type);
      if (ref.id === null) return '(entity_type = ? AND entity_id IS NULL)';
      params.push(ref.id);
      return '(entity_type = ? AND entity_id = ?)';
    });
    const readable = scopeClause(scope, params);
    params.push(limit);
    const rows = await runner.execute<QueryRows>(
      `SELECT ${COLUMNS} FROM business_facts
        WHERE organization_id = ? AND status = 'approved' AND (${named.join(' OR ')})
          AND ${readable}
        ORDER BY last_confirmed_at DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map(factOf);
  }

  async insert(runner: TenantQueryRunner, context: TenantContext, fact: NewFact): Promise<void> {
    await runner.execute(
      `INSERT INTO business_facts
        (id, organization_id, entity_type, entity_id, fact, category, source_href, audience, status,
         proposed_via, owner_user_id, proposed_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
      [
        fact.id,
        context.organizationId,
        fact.entityType,
        fact.entityId,
        fact.fact,
        fact.category,
        fact.sourceHref,
        fact.audience,
        fact.proposedVia,
        fact.ownerUserId,
        fact.proposedByUserId,
        fact.at,
        fact.at,
      ],
    );
  }

  /** proposed → approved, only from `proposed` (a race loses with `false`). */
  async approve(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<boolean> {
    return changed(
      await runner.execute<ResultSetHeader>(
        `UPDATE business_facts SET status = 'approved', approved_by_user_id = ?, approved_at = ?,
           last_confirmed_at = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND status = 'proposed'`,
        [context.userId, at, at, at, context.organizationId, id],
      ),
    );
  }

  /** Still true: an approved fact's last confirmation moves to `at`. */
  async confirm(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<boolean> {
    return changed(
      await runner.execute<ResultSetHeader>(
        `UPDATE business_facts SET last_confirmed_at = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND status = 'approved'`,
        [at, at, context.organizationId, id],
      ),
    );
  }

  async retire(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<boolean> {
    return changed(
      await runner.execute<ResultSetHeader>(
        `UPDATE business_facts SET status = 'retired', retired_by_user_id = ?, retired_at = ?,
           updated_at = ?
         WHERE organization_id = ? AND id = ? AND status IN ('proposed', 'approved')`,
        [context.userId, at, at, context.organizationId, id],
      ),
    );
  }

  /** The listed fields; an approved fact edited by a person counts as confirmed. */
  async edit(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    change: FactChange,
    at: Date,
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: SqlParameter[] = [];
    const column = {
      fact: 'fact',
      category: 'category',
      sourceHref: 'source_href',
      audience: 'audience',
      ownerUserId: 'owner_user_id',
    } as const;
    for (const key of Object.keys(column) as (keyof typeof column)[]) {
      if (!(key in change)) continue;
      sets.push(`${column[key]} = ?`);
      params.push((change[key] ?? null) as SqlParameter);
    }
    sets.push(
      "last_confirmed_at = CASE WHEN status = 'approved' THEN ? ELSE last_confirmed_at END",
      'updated_at = ?',
    );
    params.push(at, at, context.organizationId, id);
    return changed(
      await runner.execute<ResultSetHeader>(
        `UPDATE business_facts SET ${sets.join(', ')}
         WHERE organization_id = ? AND id = ? AND status IN ('proposed', 'approved')`,
        params,
      ),
    );
  }
}
