import { authorize, resolveCostRate, resolveRate } from '@tmanage/domain';
import type { AuditAction, Capability, Principal, RateSource } from '@tmanage/domain';
import type {
  MemberCostRateRow,
  RateCardEntryRow,
  RateCardRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { FINANCE_MANAGE, FINANCE_VIEW } from './finance.service.js';
import {
  MAX_REPRICE_ROWS,
  REDACTED,
  assertNoOverlap,
  isoDate,
  validateAssign,
  validateCostRate,
  validateRateCard,
  validateRateCardUpdate,
  validateRateEntry,
  validateReprice,
} from './rates-rules.js';
import type { RatesRepository, TimeLogSnapshot } from './rates.repository.js';

/**
 * 52-04 — rate cards, member cost rates, the resolver route, re-pricing and project assignment.
 *
 * Sell rates: read `finance.view`, write `finance.manage`. Cost rates (a salary proxy): read AND
 * write `finance.manage` — the stand-in for the plan's `rate.view_cost`, held by Owner / Org Admin /
 * Workspace Admin only (52-23 rule: no new capability key until the matrix is extended). Cost
 * amounts never appear in a list projection (cards, entries, resolve), never in audit changes
 * (redacted) and never in a CSV.
 */

export interface RateCardView {
  readonly id: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export interface RateEntryView {
  readonly id: string;
  readonly rateCardId: string;
  readonly targetType: string;
  readonly targetKey: string | null;
  readonly hourlyMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface ResolvedRateView {
  readonly hourlyMinor: number | null;
  readonly currency: string | null;
  readonly source: RateSource | null;
}

export interface CostRateView {
  readonly membershipId: string;
  readonly rates: readonly {
    readonly hourlyCostMinor: number;
    readonly currency: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
}

export interface RatesServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: RatesRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const cardView = (row: RateCardRow): RateCardView => ({
  id: row.id,
  scope: row.scope,
  scopeId: row.scopeId,
  name: row.name,
  currency: row.currency,
  archived: row.archivedAt !== null,
  updatedAt: row.updatedAt.toISOString(),
});

const entryView = (row: RateCardEntryRow): RateEntryView => ({
  id: row.id,
  rateCardId: row.rateCardId,
  targetType: row.targetType,
  targetKey: row.targetKey,
  hourlyMinor: Number(row.hourlyMinor),
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
});

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);

/**
 * The price snapshot of one hour on `spentOn`: the sell rate from {@link resolveRate} and the
 * member's cost rate. A missing rate is `null`, never 0. One currency column: a cost rate kept in
 * another currency than the sell rate is not converted and is left `null` on this entry.
 */
export async function priceTimeLog(
  runner: TenantQueryRunner,
  organizationId: string,
  repository: Pick<
    RatesRepository,
    'resolverCards' | 'projectPricing' | 'membershipRole' | 'costRates'
  >,
  input: {
    readonly projectId: string | null;
    readonly membershipId: string;
    readonly spentOn: string;
  },
): Promise<TimeLogSnapshot & { readonly billableDefault: boolean }> {
  const project =
    input.projectId === null
      ? null
      : await repository.projectPricing(runner, organizationId, input.projectId);
  const sell = resolveRate(await repository.resolverCards(runner, organizationId), {
    projectId: input.projectId,
    clientOrgId: project?.clientOrgId ?? null,
    membershipId: input.membershipId,
    role: await repository.membershipRole(runner, organizationId, input.membershipId),
    on: input.spentOn,
    projectRateCardId: project?.rateCardId ?? null,
  });
  const cost = resolveCostRate(
    await repository.costRates(runner, organizationId, input.membershipId),
    input.spentOn,
  );
  const currency = sell?.currency ?? cost?.currency ?? null;
  return {
    rateSnapshotMinor: sell?.hourlyMinor ?? null,
    costSnapshotMinor:
      cost !== null && cost.currency === currency ? Number(cost.hourlyCostMinor) : null,
    snapshotCurrency: currency,
    billableDefault: project?.billableDefault ?? true,
  };
}

export class RatesService {
  private readonly now: () => Date;

  constructor(private readonly options: RatesServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async listCards(context: TenantContext, principal: Principal): Promise<readonly RateCardView[]> {
    this.require(principal, context, FINANCE_VIEW);
    const rows = await this.options.database.read(context, (r) =>
      this.options.repository.cards(r, context.organizationId),
    );
    return rows.map(cardView);
  }

  async createCard(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<RateCardView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateRateCard(body);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      await this.requireScope(tx, context, input.scope, input.scopeId);
      const id = await repo.insertCard(tx, context.organizationId, input, context.userId, at);
      await this.audited(tx, context, 'rate_card.created', id, { scope: input.scope }, [
        { field: 'name', before: null, after: input.name },
        { field: 'currency', before: null, after: input.currency },
      ]);
      return cardView(await this.requireCard(tx, context, id));
    });
  }

  async updateCard(
    context: TenantContext,
    principal: Principal,
    cardId: string,
    body: unknown,
  ): Promise<RateCardView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateRateCardUpdate(body);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.requireCard(tx, context, cardId, true);
      const archived = input.archived ?? row.archivedAt !== null;
      await this.options.repository.updateCard(
        tx,
        context.organizationId,
        row.id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          archivedAt: archived ? (row.archivedAt ?? at) : null,
        },
        at,
      );
      const changes = [];
      if (input.name !== undefined && input.name !== row.name)
        changes.push({ field: 'name', before: row.name, after: input.name });
      if (archived !== (row.archivedAt !== null))
        changes.push({ field: 'archived', before: !archived, after: archived });
      await this.audited(tx, context, 'rate_card.updated', row.id, {}, changes);
      return cardView(await this.requireCard(tx, context, row.id));
    });
  }

  async listEntries(
    context: TenantContext,
    principal: Principal,
    cardId: string,
  ): Promise<readonly RateEntryView[]> {
    this.require(principal, context, FINANCE_VIEW);
    return this.options.database.read(context, async (r) => {
      const card = await this.requireCard(r, context, cardId);
      return (await this.options.repository.entries(r, context.organizationId, [card.id])).map(
        entryView,
      );
    });
  }

  async addEntry(
    context: TenantContext,
    principal: Principal,
    cardId: string,
    body: unknown,
  ): Promise<RateEntryView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateRateEntry(body);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      const card = await this.requireCard(tx, context, cardId, true);
      if (input.targetType === 'membership') {
        const role = await repo.membershipRole(tx, context.organizationId, input.targetKey ?? '');
        if (role === null) throw notFound();
      }
      const existing = (await repo.entries(tx, context.organizationId, [card.id])).filter(
        (e) => e.targetType === input.targetType && e.targetKey === input.targetKey,
      );
      assertNoOverlap(existing, input);
      const row = await repo.insertEntry(tx, context.organizationId, card.id, input, at);
      await this.audited(
        tx,
        context,
        'rate_card.entry_added',
        card.id,
        { entry_id: row.id, target_type: input.targetType },
        [
          { field: 'hourlyMinor', before: null, after: input.hourlyMinor },
          { field: 'effectiveFrom', before: null, after: input.effectiveFrom },
        ],
      );
      return entryView(row);
    });
  }

  async removeEntry(
    context: TenantContext,
    principal: Principal,
    cardId: string,
    entryId: string,
  ): Promise<void> {
    this.require(principal, context, FINANCE_MANAGE);
    await this.options.database.transaction(context, async (tx) => {
      const card = await this.requireCard(tx, context, cardId, true);
      const removed = await this.options.repository.deleteEntry(
        tx,
        context.organizationId,
        card.id,
        entryId,
      );
      if (removed === 0) throw notFound();
      await this.audited(
        tx,
        context,
        'rate_card.entry_removed',
        card.id,
        { entry_id: entryId },
        [],
      );
    });
  }

  /** The sell rate for one project / member / day. Never a cost field. */
  async resolve(
    context: TenantContext,
    principal: Principal,
    query: { projectId?: unknown; membershipId?: unknown; on?: unknown },
  ): Promise<ResolvedRateView> {
    this.require(principal, context, FINANCE_VIEW);
    const on = isoDate(query.on, 'on');
    const membershipId = typeof query.membershipId === 'string' ? query.membershipId : null;
    const projectId = typeof query.projectId === 'string' ? query.projectId : null;
    return this.options.database.read(context, async (r) => {
      const repo = this.options.repository;
      const project =
        projectId === null ? null : await repo.projectPricing(r, context.organizationId, projectId);
      if (projectId !== null && project === null) throw notFound();
      const role =
        membershipId === null
          ? null
          : await repo.membershipRole(r, context.organizationId, membershipId);
      if (membershipId !== null && role === null) throw notFound();
      const rate = resolveRate(await repo.resolverCards(r, context.organizationId), {
        projectId,
        clientOrgId: project?.clientOrgId ?? null,
        membershipId,
        role,
        on,
        projectRateCardId: project?.rateCardId ?? null,
      });
      return {
        hourlyMinor: rate?.hourlyMinor ?? null,
        currency: rate?.currency ?? null,
        source: rate?.source ?? null,
      };
    });
  }

  /** `finance.manage` (stand-in for `rate.view_cost`). */
  async getCostRates(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
  ): Promise<CostRateView> {
    this.require(principal, context, FINANCE_MANAGE);
    return this.options.database.read(context, async (r) => {
      const repo = this.options.repository;
      if ((await repo.membershipRole(r, context.organizationId, membershipId)) === null)
        throw notFound();
      return costView(membershipId, await repo.costRates(r, context.organizationId, membershipId));
    });
  }

  /** Add one cost window for the member; overlapping windows are refused. */
  async putCostRate(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
    body: unknown,
  ): Promise<CostRateView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateCostRate(body);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      if ((await repo.membershipRole(tx, context.organizationId, membershipId)) === null)
        throw notFound();
      assertNoOverlap(await repo.costRates(tx, context.organizationId, membershipId), input);
      await repo.insertCostRate(
        tx,
        context.organizationId,
        membershipId,
        input,
        context.userId,
        at,
      );
      await this.audited(tx, context, 'cost_rate.changed', membershipId, {}, [
        { field: 'hourlyCostMinor', before: REDACTED, after: REDACTED },
        { field: 'effectiveFrom', before: null, after: input.effectiveFrom },
      ]);
      return costView(membershipId, await repo.costRates(tx, context.organizationId, membershipId));
    });
  }

  /**
   * Re-snapshot unbilled, unlocked entries up to `until` (max {@link MAX_REPRICE_ROWS}; more is a
   * 422 asking for a narrower call). Audited with the count only.
   */
  async reprice(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<{ readonly repriced: number }> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateReprice(body);
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      const projectId = input.projectId === 'all' ? null : input.projectId;
      if (projectId !== null && !(await repo.projectExists(tx, context.organizationId, projectId)))
        throw notFound();
      const rows = await repo.repriceCandidates(tx, context.organizationId, {
        projectId,
        until: input.until,
        limit: MAX_REPRICE_ROWS + 1,
      });
      if (rows.length > MAX_REPRICE_ROWS) {
        throw new ApiError(422, 'validation_failed', 'Too many entries to re-price at once.', [
          { field: 'until', message: `narrow the range to at most ${MAX_REPRICE_ROWS} entries` },
        ]);
      }
      for (const row of rows) {
        const { billableDefault: _ignored, ...snapshot } = await priceTimeLog(
          tx,
          context.organizationId,
          repo,
          { projectId: row.projectId, membershipId: row.loggedBy, spentOn: row.spentOn },
        );
        await repo.writeSnapshot(tx, context.organizationId, row.id, snapshot);
      }
      await this.audited(
        tx,
        context,
        'rates.repriced',
        context.organizationId,
        { count: rows.length, scope: projectId === null ? 'all' : 'project', until: input.until },
        [],
      );
      return { repriced: rows.length };
    });
  }

  async assign(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<{
    readonly projectId: string;
    readonly rateCardId: string | null;
    readonly billableDefault: boolean;
  }> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateAssign(body);
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      const before = await repo.projectPricing(tx, context.organizationId, input.projectId);
      if (before === null) throw notFound();
      if (input.rateCardId !== null) {
        const card = await this.requireCard(tx, context, input.rateCardId);
        if (card.archivedAt !== null) throw notFound();
      }
      await repo.setProjectRates(tx, context.organizationId, input.projectId, {
        rateCardId: input.rateCardId,
        ...(input.billableDefault === undefined ? {} : { billableDefault: input.billableDefault }),
      });
      const billableDefault = input.billableDefault ?? before.billableDefault;
      await this.audited(
        tx,
        context,
        'rate_card.updated',
        input.rateCardId ?? before.rateCardId,
        { project_id: input.projectId },
        [
          { field: 'projectRateCardId', before: before.rateCardId, after: input.rateCardId },
          { field: 'billableDefault', before: before.billableDefault, after: billableDefault },
        ],
      );
      return { projectId: input.projectId, rateCardId: input.rateCardId, billableDefault };
    });
  }

  private async requireScope(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: string,
    scopeId: string | null,
  ): Promise<void> {
    if (scopeId === null) return;
    const repo = this.options.repository;
    const found =
      scope === 'client'
        ? await repo.clientOrgExists(runner, context.organizationId, scopeId)
        : await repo.projectExists(runner, context.organizationId, scopeId);
    if (!found) throw notFound();
  }

  private async requireCard(
    runner: TenantQueryRunner,
    context: TenantContext,
    cardId: string,
    lock = false,
  ): Promise<RateCardRow> {
    const row = await this.options.repository.card(runner, context.organizationId, cardId, lock);
    if (row === null) throw notFound();
    return row;
  }

  private require(principal: Principal, context: TenantContext, capability: Capability): void {
    const decision = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'finance.denied');
    }
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    objectId: string | null,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
    changes: readonly {
      readonly field: string;
      readonly before: unknown;
      readonly after: unknown;
    }[],
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
      changes,
    });
  }
}

function costView(membershipId: string, rows: readonly MemberCostRateRow[]): CostRateView {
  return {
    membershipId,
    rates: rows.map((row) => ({
      hourlyCostMinor: Number(row.hourlyCostMinor),
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    })),
  };
}
