import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import type { AuditService } from '../../audit/audit.service.js';
import {
  BUSINESS_MEMORY_LIST_LIMIT,
  BUSINESS_MEMORY_RECALL_LIMIT,
  isStale,
  isUuid,
  mayReadFact,
  parseEdit,
  parseEntityRefs,
  parseProposal,
  readableAudiences,
  staleCutoff,
  type BusinessFact,
  type BusinessFactAudience,
  type BusinessFactEntityType,
  type BusinessFactStatus,
  type FactReadScope,
  type FieldIssue,
} from './business-memory.js';
import type { BusinessMemoryRepository, FactChange } from './business-memory.repository.js';
import {
  BUSINESS_FACT_ENTITY_TYPES,
  BUSINESS_FACT_STATUSES,
} from '../../../common/database/schema.js';

/**
 * 62-26 (plan 62 §4.6) — Business Memory, the service behind
 * `/v1/organizations/:orgSlug/business-memory/…`.
 *
 * - **Propose** (`ai.use`): a member, or the AI through the member's confirmed card (the registry
 *   op is confirm-class), adds a `proposed` fact. Nothing a proposal says reaches the AI recall.
 * - **Approve, edit, confirm, retire** (`ai.manage`, the owner and admins): never AI ops (the
 *   registry lists them NEVER). Approval is what lets the recall read a fact.
 * - **Recall** (`ai.use`): at most {@link BUSINESS_MEMORY_RECALL_LIMIT} approved facts about the
 *   named entities that the member may read; the chat hands them to the model as untrusted data.
 * - Every change writes its audit row in the same transaction (ASVS 5.0 V16): classifications and
 *   field names only, never the fact text.
 * - A fact the caller may not read is 404, never 403, so its existence does not leak.
 */

export const BUSINESS_FACT_AUDIT = {
  proposed: 'business_fact.proposed',
  approved: 'business_fact.approved',
  updated: 'business_fact.updated',
  confirmed: 'business_fact.confirmed',
  retired: 'business_fact.retired',
} as const;

/** One fact as the routes answer it. No web client yet (the screen is 62-26 front end). */
export interface BusinessFactView {
  readonly id: string;
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: string;
  readonly sourceHref: string | null;
  readonly audience: BusinessFactAudience;
  readonly status: BusinessFactStatus;
  readonly proposedVia: 'ai' | 'member';
  readonly ownerUserId: string;
  readonly proposedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly lastConfirmedAt: string | null;
  readonly retiredAt: string | null;
  readonly stale: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BusinessFactListView {
  readonly facts: readonly BusinessFactView[];
}

export interface BusinessMemoryServiceOptions {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly repository: BusinessMemoryRepository;
  readonly now?: () => Date;
}

export interface FactListQuery {
  readonly status?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly stale?: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function validation(issues: readonly FieldIssue[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The Business Memory request is not valid.', [
    ...issues,
  ]);
}

function notFound(cause: string): ApiError {
  return new ApiError(404, 'not_found', 'Not found.', undefined, cause);
}

function conflict(cause: string, message: string): ApiError {
  return new ApiError(409, 'conflict', message, undefined, cause);
}

export class BusinessMemoryService {
  private readonly now: () => Date;

  constructor(private readonly options: BusinessMemoryServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  view(fact: BusinessFact, now = this.now()): BusinessFactView {
    return {
      id: fact.id,
      entityType: fact.entityType,
      entityId: fact.entityId,
      fact: fact.fact,
      category: fact.category,
      sourceHref: fact.sourceHref,
      audience: fact.audience,
      status: fact.status,
      proposedVia: fact.proposedVia,
      ownerUserId: fact.ownerUserId,
      proposedByUserId: fact.proposedByUserId,
      approvedByUserId: fact.approvedByUserId,
      approvedAt: iso(fact.approvedAt),
      lastConfirmedAt: iso(fact.lastConfirmedAt),
      retiredAt: iso(fact.retiredAt),
      stale: isStale(fact, now),
      createdAt: fact.createdAt.toISOString(),
      updatedAt: fact.updatedAt.toISOString(),
    };
  }

  /** What this reader may see (audiences from capabilities, entities from the principal). */
  async scopeOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
  ): Promise<FactReadScope> {
    const internal = principal.kind === 'internal' && context.principalKind === 'internal';
    const projectIds = principal.hasOrgWideScope ? [] : [...principal.projectIds];
    const clientIds =
      internal && !principal.hasOrgWideScope
        ? await this.options.repository.clientIdsOfProjects(runner, context, projectIds)
        : [];
    return {
      internal,
      orgWide: principal.hasOrgWideScope,
      orgLevel: principal.hasOrgWideScope || principal.role !== 'guest',
      projectIds: new Set(projectIds),
      clientIds: new Set(clientIds),
      audiences: readableAudiences(context.capabilities),
    };
  }

  async list(
    context: TenantContext,
    principal: Principal,
    query: FactListQuery,
  ): Promise<BusinessFactListView> {
    const issues: FieldIssue[] = [];
    const approver = context.capabilities.includes('ai.manage');
    let statuses: BusinessFactStatus[] = ['approved', 'proposed'];
    if (query.status !== undefined) {
      if (query.status === 'all') statuses = [...BUSINESS_FACT_STATUSES];
      else if ((BUSINESS_FACT_STATUSES as readonly string[]).includes(query.status)) {
        statuses = [query.status as BusinessFactStatus];
      } else
        issues.push({ field: 'status', message: 'must be proposed, approved, retired or all' });
    }
    if (
      query.entityType !== undefined &&
      !(BUSINESS_FACT_ENTITY_TYPES as readonly string[]).includes(query.entityType)
    ) {
      issues.push({
        field: 'entityType',
        message: 'must be client, project, person, process or company',
      });
    }
    if (query.entityId !== undefined && !isUuid(query.entityId)) {
      issues.push({ field: 'entityId', message: 'must be the id of the record' });
    }
    if (query.stale !== undefined && query.stale !== 'true' && query.stale !== 'false') {
      issues.push({ field: 'stale', message: 'must be true or false' });
    }
    if (issues.length > 0) throw validation(issues);
    const now = this.now();
    const facts = await this.options.database.read(context, async (runner) => {
      const scope = await this.scopeOf(runner, context, principal);
      const rows = await this.options.repository.list(runner, context, scope, {
        statuses,
        ownProposalsOnly: approver ? null : context.userId,
        ...(query.entityType === undefined
          ? {}
          : { entityType: query.entityType as BusinessFactEntityType }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId.toLowerCase() }),
        ...(query.stale === 'true' ? { staleBefore: staleCutoff(now) } : {}),
        limit: BUSINESS_MEMORY_LIST_LIMIT,
      });
      // Re-check every row with the same rule the SQL applied.
      return rows.filter((fact) => mayReadFact(scope, fact));
    });
    return { facts: facts.map((fact) => this.view(fact, now)) };
  }

  /** The AI recall: approved facts only, readable by the member, at most eight. */
  async recall(
    context: TenantContext,
    principal: Principal,
    entities: unknown,
  ): Promise<BusinessFactListView> {
    const parsed = parseEntityRefs(entities);
    if (!parsed.ok) throw validation(parsed.issues);
    const now = this.now();
    const facts = await this.options.database.read(context, async (runner) => {
      const scope = await this.scopeOf(runner, context, principal);
      const rows = await this.options.repository.recall(
        runner,
        context,
        scope,
        parsed.value,
        BUSINESS_MEMORY_RECALL_LIMIT,
      );
      return rows
        .filter((fact) => fact.status === 'approved' && mayReadFact(scope, fact))
        .slice(0, BUSINESS_MEMORY_RECALL_LIMIT);
    });
    return { facts: facts.map((fact) => this.view(fact, now)) };
  }

  async propose(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<BusinessFactView> {
    const parsed = parseProposal(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const fields = parsed.value;
    const at = this.now();
    const fact = await this.options.database.transaction(context, async (tx) => {
      const scope = await this.scopeOf(tx, context, principal);
      // A member may only propose what they could read back: the entity and the audience.
      if (!mayReadFact(scope, fields)) throw notFound('business_fact:entity_not_visible');
      if (
        fields.entityId !== null &&
        !(await this.options.repository.entityExists(
          tx,
          context,
          fields.entityType,
          fields.entityId,
        ))
      ) {
        throw notFound('business_fact:entity_missing');
      }
      const owner = fields.ownerUserId ?? context.userId;
      if (
        owner !== context.userId &&
        !(await this.options.repository.isActiveMember(tx, context, owner))
      ) {
        throw validation([{ field: 'ownerUserId', message: 'must be an active member' }]);
      }
      const duplicate = await this.options.repository.findDuplicate(tx, context, fields);
      if (duplicate !== null) {
        throw conflict('business_fact:duplicate', 'This fact is already in Business Memory.');
      }
      const id = uuidv7();
      await this.options.repository.insert(tx, context, {
        id,
        entityType: fields.entityType,
        entityId: fields.entityId,
        fact: fields.fact,
        category: fields.category,
        sourceHref: fields.sourceHref,
        audience: fields.audience,
        proposedVia: context.actorChannel === 'ai_assistant' ? 'ai' : 'member',
        ownerUserId: owner,
        proposedByUserId: context.userId,
        at,
      });
      await this.options.audit.record(tx, context, {
        action: BUSINESS_FACT_AUDIT.proposed,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: {
          entity_type: fields.entityType,
          category: fields.category,
          audience: fields.audience,
          proposed_via: context.actorChannel === 'ai_assistant' ? 'ai' : 'member',
        },
      });
      return this.options.repository.find(tx, context, id);
    });
    return this.view(fact!, at);
  }

  async approve(
    context: TenantContext,
    principal: Principal,
    factId: string,
  ): Promise<BusinessFactView> {
    return this.transition(context, principal, factId, 'approved', (tx, at) =>
      this.options.repository.approve(tx, context, factId, at),
    );
  }

  async confirm(
    context: TenantContext,
    principal: Principal,
    factId: string,
  ): Promise<BusinessFactView> {
    return this.transition(context, principal, factId, 'confirmed', (tx, at) =>
      this.options.repository.confirm(tx, context, factId, at),
    );
  }

  async retire(
    context: TenantContext,
    principal: Principal,
    factId: string,
  ): Promise<BusinessFactView> {
    return this.transition(context, principal, factId, 'retired', (tx, at) =>
      this.options.repository.retire(tx, context, factId, at),
    );
  }

  async edit(
    context: TenantContext,
    principal: Principal,
    factId: string,
    body: unknown,
  ): Promise<BusinessFactView> {
    const parsed = parseEdit(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const change: FactChange = parsed.value;
    return this.transition(
      context,
      principal,
      factId,
      'updated',
      async (tx, at, current, scope) => {
        // The new audience must still be one the editor can read.
        if (
          change.audience !== undefined &&
          !mayReadFact(scope, { ...current, audience: change.audience })
        ) {
          throw validation([{ field: 'audience', message: 'must be one you can read' }]);
        }
        if (
          change.ownerUserId !== undefined &&
          !(await this.options.repository.isActiveMember(tx, context, change.ownerUserId))
        ) {
          throw validation([{ field: 'ownerUserId', message: 'must be an active member' }]);
        }
        return this.options.repository.edit(tx, context, factId, change, at);
      },
      Object.keys(change),
    );
  }

  private async transition(
    context: TenantContext,
    principal: Principal,
    factId: string,
    step: Exclude<keyof typeof BUSINESS_FACT_AUDIT, 'proposed'>,
    apply: (
      tx: TenantQueryRunner,
      at: Date,
      current: BusinessFact,
      scope: FactReadScope,
    ) => Promise<boolean>,
    fields: readonly string[] = [],
  ): Promise<BusinessFactView> {
    if (!isUuid(factId)) throw notFound('business_fact:bad_id');
    const at = this.now();
    const fact = await this.options.database.transaction(context, async (tx) => {
      const scope = await this.scopeOf(tx, context, principal);
      const current = await this.options.repository.find(tx, context, factId, { forUpdate: true });
      if (current === null || !mayReadFact(scope, current))
        throw notFound('business_fact:not_visible');
      if (!(await apply(tx, at, current, scope))) {
        throw conflict(
          `business_fact:${step}_from_${current.status}`,
          'The fact has changed state.',
        );
      }
      await this.options.audit.record(tx, context, {
        action: BUSINESS_FACT_AUDIT[step],
        result: 'allowed',
        objectId: factId,
        actorUserId: context.userId,
        metadata: {
          entity_type: current.entityType,
          from_status: current.status,
          ...(fields.length === 0 ? {} : { fields: [...fields] }),
        },
      });
      return this.options.repository.find(tx, context, factId);
    });
    return this.view(fact!, at);
  }
}
