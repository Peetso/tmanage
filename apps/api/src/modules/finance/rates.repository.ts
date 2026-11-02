import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { RateCardInput, RateCardScope, RateTargetType } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientOrganizations,
  memberCostRates,
  memberships,
  projectClients,
  projectRateSettings,
  projects,
  rateCardEntries,
  rateCards,
  timeLogPricing,
  workItemBilling,
} from '../../common/database/schema.js';
import type {
  MemberCostRateRow,
  RateCardEntryRow,
  RateCardRow,
} from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { CostRateBody, RateEntryBody } from './rates-rules.js';

/**
 * 52-04 — storage for `rate_cards`, `rate_card_entries`, `member_cost_rates` (0287) and the 0287
 * columns of `projects`, `work_items` and `work_item_time_logs`. Every statement carries the
 * `organization_id` predicate; another organization's row is simply absent. No policy here.
 */

export interface TimeLogSnapshot {
  readonly rateSnapshotMinor: number | null;
  readonly costSnapshotMinor: number | null;
  readonly snapshotCurrency: string | null;
}

export interface RepriceCandidate {
  readonly id: string;
  readonly projectId: string | null;
  readonly loggedBy: string;
  readonly spentOn: string;
}

export class RatesRepository {
  async cards(runner: TenantQueryRunner, organizationId: string): Promise<readonly RateCardRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(rateCards)
      .where(eq(rateCards.organizationId, organizationId))
      .orderBy(asc(rateCards.scope), desc(rateCards.createdAt))
      .limit(500);
  }

  async card(
    runner: TenantQueryRunner,
    organizationId: string,
    cardId: string,
    lock = false,
  ): Promise<RateCardRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.organizationId, organizationId), eq(rateCards.id, cardId)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insertCard(
    runner: TenantQueryRunner,
    organizationId: string,
    values: { scope: RateCardScope; scopeId: string | null; name: string; currency: string },
    createdBy: string,
    at: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(rateCards)
      .values({
        id,
        organizationId,
        ...values,
        archivedAt: null,
        createdBy,
        createdAt: at,
        updatedAt: at,
      });
    return id;
  }

  async updateCard(
    runner: TenantQueryRunner,
    organizationId: string,
    cardId: string,
    change: { name?: string; archivedAt?: Date | null },
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(rateCards)
      .set({ ...change, updatedAt: at })
      .where(and(eq(rateCards.organizationId, organizationId), eq(rateCards.id, cardId)));
  }

  async entries(
    runner: TenantQueryRunner,
    organizationId: string,
    cardIds: readonly string[],
  ): Promise<readonly RateCardEntryRow[]> {
    if (cardIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(rateCardEntries)
      .where(
        and(
          eq(rateCardEntries.organizationId, organizationId),
          inArray(rateCardEntries.rateCardId, [...cardIds]),
        ),
      )
      .orderBy(asc(rateCardEntries.targetType), asc(rateCardEntries.effectiveFrom))
      .limit(5_000);
  }

  async insertEntry(
    runner: TenantQueryRunner,
    organizationId: string,
    cardId: string,
    input: RateEntryBody,
    at: Date,
  ): Promise<RateCardEntryRow> {
    const row: RateCardEntryRow = {
      id: uuidv7(),
      organizationId,
      rateCardId: cardId,
      targetType: input.targetType,
      targetKey: input.targetKey,
      hourlyMinor: input.hourlyMinor,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      createdAt: at,
    };
    await tenantDrizzle(runner).insert(rateCardEntries).values(row);
    return row;
  }

  async deleteEntry(
    runner: TenantQueryRunner,
    organizationId: string,
    cardId: string,
    entryId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(rateCardEntries)
      .where(
        and(
          eq(rateCardEntries.organizationId, organizationId),
          eq(rateCardEntries.rateCardId, cardId),
          eq(rateCardEntries.id, entryId),
        ),
      );
    return result[0].affectedRows;
  }

  async costRates(
    runner: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
  ): Promise<readonly MemberCostRateRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(memberCostRates)
      .where(
        and(
          eq(memberCostRates.organizationId, organizationId),
          eq(memberCostRates.membershipId, membershipId),
        ),
      )
      .orderBy(desc(memberCostRates.effectiveFrom))
      .limit(200);
  }

  async insertCostRate(
    runner: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
    input: CostRateBody,
    createdBy: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(memberCostRates)
      .values({ id: uuidv7(), organizationId, membershipId, ...input, createdBy, createdAt: at });
  }

  async membershipRole(
    runner: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, membershipId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  async clientOrgExists(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrgId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: clientOrganizations.id })
      .from(clientOrganizations)
      .where(
        and(
          eq(clientOrganizations.organizationId, organizationId),
          eq(clientOrganizations.id, clientOrgId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async projectExists(
    runner: TenantQueryRunner,
    organizationId: string,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  /** The project's billing settings and its first linked client; `null` for no such project. */
  async projectPricing(
    runner: TenantQueryRunner,
    organizationId: string,
    projectId: string,
  ): Promise<{
    billableDefault: boolean;
    rateCardId: string | null;
    clientOrgId: string | null;
  } | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        billableDefault: projectRateSettings.billableDefault,
        rateCardId: projectRateSettings.rateCardId,
      })
      .from(projectRateSettings)
      .where(
        and(
          eq(projectRateSettings.organizationId, organizationId),
          eq(projectRateSettings.id, projectId),
        ),
      )
      .limit(1);
    const project = rows[0];
    if (!project) return null;
    const clients = await db
      .select({ clientOrgId: projectClients.clientOrganizationId })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, organizationId),
          eq(projectClients.projectId, projectId),
        ),
      )
      .orderBy(asc(projectClients.createdAt))
      .limit(1);
    return { ...project, clientOrgId: clients[0]?.clientOrgId ?? null };
  }

  async setProjectRates(
    runner: TenantQueryRunner,
    organizationId: string,
    projectId: string,
    change: { rateCardId: string | null; billableDefault?: boolean },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(projectRateSettings)
      .set(change)
      .where(
        and(
          eq(projectRateSettings.organizationId, organizationId),
          eq(projectRateSettings.id, projectId),
        ),
      );
  }

  async workItemBillable(
    runner: TenantQueryRunner,
    organizationId: string,
    workItemId: string,
  ): Promise<boolean | null> {
    const rows = await tenantDrizzle(runner)
      .select({ billable: workItemBilling.billable })
      .from(workItemBilling)
      .where(
        and(eq(workItemBilling.organizationId, organizationId), eq(workItemBilling.id, workItemId)),
      )
      .limit(1);
    return rows[0]?.billable ?? null;
  }

  async setWorkItemBillable(
    runner: TenantQueryRunner,
    organizationId: string,
    workItemId: string,
    billable: boolean | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemBilling)
      .set({ billable })
      .where(
        and(eq(workItemBilling.organizationId, organizationId), eq(workItemBilling.id, workItemId)),
      );
  }

  /** Unbilled (`invoice_line_id IS NULL`), unlocked entries up to `until`, at most `limit`. */
  async repriceCandidates(
    runner: TenantQueryRunner,
    organizationId: string,
    filter: { projectId: string | null; until: string; limit: number },
  ): Promise<readonly RepriceCandidate[]> {
    const predicates = [
      eq(timeLogPricing.organizationId, organizationId),
      isNull(timeLogPricing.invoiceLineId),
      isNull(timeLogPricing.lockedAt),
      lte(timeLogPricing.spentOn, filter.until),
    ];
    if (filter.projectId !== null) predicates.push(eq(timeLogPricing.projectId, filter.projectId));
    return tenantDrizzle(runner)
      .select({
        id: timeLogPricing.id,
        projectId: timeLogPricing.projectId,
        loggedBy: timeLogPricing.loggedBy,
        spentOn: timeLogPricing.spentOn,
      })
      .from(timeLogPricing)
      .where(and(...predicates))
      .orderBy(asc(timeLogPricing.id))
      .limit(filter.limit)
      .for('update');
  }

  /** Write the snapshot columns; re-states the unbilled + unlocked guard on the row itself. */
  async writeSnapshot(
    runner: TenantQueryRunner,
    organizationId: string,
    timeLogId: string,
    snapshot: TimeLogSnapshot,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(timeLogPricing)
      .set(snapshot)
      .where(
        and(
          eq(timeLogPricing.organizationId, organizationId),
          eq(timeLogPricing.id, timeLogId),
          isNull(timeLogPricing.invoiceLineId),
          isNull(timeLogPricing.lockedAt),
        ),
      );
  }

  /** Every card with its entries, in the resolver's input shape. */
  async resolverCards(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<readonly RateCardInput[]> {
    const cards = (await this.cards(runner, organizationId)).filter((c) => c.archivedAt === null);
    const entries = await this.entries(
      runner,
      organizationId,
      cards.map((c) => c.id),
    );
    return cards.map((card) => ({
      id: card.id,
      scope: card.scope as RateCardScope,
      scopeId: card.scopeId,
      currency: card.currency,
      archived: false,
      entries: entries
        .filter((e) => e.rateCardId === card.id)
        .map((e) => ({
          targetType: e.targetType as RateTargetType,
          targetKey: e.targetKey,
          hourlyMinor: Number(e.hourlyMinor),
          effectiveFrom: e.effectiveFrom,
          effectiveTo: e.effectiveTo,
        })),
    }));
  }
}
