import { authorize, uuidv7 } from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import type { RetainerPeriodRow, RetainerRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { defaultProfile } from './finance-rules.js';
import type { FinanceRepository } from './finance.repository.js';
import { FINANCE_MANAGE, FINANCE_VIEW } from './finance.service.js';
import {
  ENTRY_PAGE,
  MAX_PERIODS_LISTED,
  MAX_RETAINER_PROJECTS,
  PORTAL_ENTRY_LIMIT,
  addDays,
  allowanceOf,
  cursorOf,
  hoursOf,
  invalid,
  nextRetainerState,
  overageOf,
  overlapsLock,
  periodBounds,
  validateRetainer,
  validateRetainerPatch,
} from './retainers-rules.js';
import type { RetainerEvent } from './retainers-rules.js';
import type { RetainerChange, RetainersRepository } from './retainers.repository.js';

/**
 * 52-06 — retainers: create (with the first period), edit, pause / resume / end, the periods with
 * read-time attribution, the entries behind a period, and the client's portal projection.
 *
 * Capability stand-ins (no `capabilities.ts` edit): `retainer.manage` → `finance.manage`;
 * `retainer.view` → `finance.view` (everything) or `work.read` with a relation to a covered project
 * (hours only: `amountPerPeriodMinor` and `currency` are dropped). Portal: `client_projection.read`,
 * `client_visible = 1` and the client principal's own organization, otherwise 404 — the same answer
 * as an unknown retainer.
 *
 * Attribution is a SUM at read time over `work_item_time_logs` on the covered projects with
 * `spent_on` inside the period: live for the open period, the frozen cache for a closed one (the
 * hourly worker roll writes it at close). `work_item_time_logs.retainer_period_id` is reserved and
 * never written. 52-09 is not built: `invoice_id` stays NULL and there is no "Invoice this period".
 */

export interface RetainerView {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly name: string;
  readonly period: string;
  readonly hoursPerPeriod: number | null;
  /** Only with `finance.view`. */
  readonly amountPerPeriodMinor?: number | null;
  /** Only with `finance.view`. */
  readonly currency?: string | null;
  readonly rollover: string;
  readonly rolloverCapMinutes: number | null;
  readonly billingTiming: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly state: string;
  readonly clientVisible: boolean;
  readonly projectIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RetainerPeriodView {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly state: string;
  readonly allowanceMinutes: number;
  readonly rolloverInMinutes: number;
  readonly usedMinutes: number;
  readonly overageMinutes: number;
  readonly remainingMinutes: number;
  /** Any day of the period inside an open 52-03 lock. */
  readonly locked: boolean;
  readonly closedAt: string | null;
}

export interface RetainerEntryView {
  readonly id: string;
  readonly date: string;
  readonly itemTitle: string | null;
  readonly memberUserId: string;
  readonly minutes: number;
  /** 2026-11-23 time trust: typed in or corrected (approved), not measured by the timer. */
  readonly addedByHand: boolean;
}

/** Exactly what a client may see: no person, no money, no internal title. */
export interface PortalRetainerView {
  readonly name: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly allowanceHours: number;
  readonly usedHours: number;
  readonly remainingHours: number;
  readonly renewsOn: string | null;
  /** `addedByHand`: the client sees which hours were typed in rather than measured (2026-11-23). */
  readonly entries: readonly {
    date: string;
    taskTitle: string;
    hours: number;
    addedByHand: boolean;
  }[];
}

export type PortalRetainerSummary = Omit<PortalRetainerView, 'entries'> & { readonly id: string };

export const INTERNAL_WORK_TITLE = 'Internal work';
const CLIENT_TITLE_AUDIENCES: ReadonlySet<string> = new Set([
  'client_visible',
  'client_action_required',
]);

export interface RetainersServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: RetainersRepository;
  readonly finance: Pick<FinanceRepository, 'profile' | 'organization'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);
const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);
const conflict = (message: string, field = 'state'): ApiError =>
  new ApiError(409, 'conflict', message, [{ field, message }]);

export function retainerView(
  row: RetainerRow,
  projectIds: readonly string[],
  money: boolean,
): RetainerView {
  return {
    id: row.id,
    clientOrganizationId: row.clientOrganizationId,
    name: row.name,
    period: row.period,
    hoursPerPeriod: row.hoursPerPeriod,
    ...(money
      ? {
          amountPerPeriodMinor:
            row.amountPerPeriodMinor === null ? null : Number(row.amountPerPeriodMinor),
          currency: row.currency,
        }
      : {}),
    rollover: row.rollover,
    rolloverCapMinutes: row.rolloverCapMinutes,
    billingTiming: row.billingTiming,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    state: row.state,
    clientVisible: row.clientVisible,
    projectIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function periodView(
  row: RetainerPeriodRow,
  usedMinutes: number,
  locked: boolean,
): RetainerPeriodView {
  const offered = row.allowanceMinutes + row.rolloverInMinutes;
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    state: row.state,
    allowanceMinutes: row.allowanceMinutes,
    rolloverInMinutes: row.rolloverInMinutes,
    usedMinutes,
    overageMinutes: overageOf(row.allowanceMinutes, row.rolloverInMinutes, usedMinutes),
    remainingMinutes: Math.max(0, offered - usedMinutes),
    locked,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** The title a client may read: the item's own only when its audience is client-facing. */
export function clientTaskTitle(entry: {
  title: string | null;
  audience: string | null;
  itemDeleted: boolean;
}): string {
  return entry.title !== null &&
    !entry.itemDeleted &&
    entry.audience !== null &&
    CLIENT_TITLE_AUDIENCES.has(entry.audience)
    ? entry.title
    : INTERNAL_WORK_TITLE;
}

export class RetainersService {
  private readonly now: () => Date;

  constructor(private readonly options: RetainersServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get repo(): RetainersRepository {
    return this.options.repository;
  }

  // ---- internal reads ----

  async listForClient(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<{ readonly retainers: readonly RetainerView[] }> {
    this.requireInternal(principal);
    const org = context.organizationId;
    const money = this.allows(principal, context, FINANCE_VIEW, null);
    return this.options.database.read(context, async (r) => {
      if (!(await this.repo.clientExists(r, org, clientOrganizationId))) throw notFound();
      const rows = await this.repo.listForClient(r, org, clientOrganizationId);
      const projects = await this.repo.projectsOf(
        r,
        org,
        rows.map((row) => row.id),
      );
      return {
        retainers: rows
          .filter((row) => this.mayView(principal, context, projects.get(row.id) ?? []))
          .map((row) => retainerView(row, projects.get(row.id) ?? [], money)),
      };
    });
  }

  async get(context: TenantContext, principal: Principal, id: string): Promise<RetainerView> {
    this.requireInternal(principal);
    return this.options.database.read(context, async (r) => {
      const { row, projectIds } = await this.visible(r, context, principal, id);
      return retainerView(row, projectIds, this.allows(principal, context, FINANCE_VIEW, null));
    });
  }

  async periods(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<{ readonly retainerId: string; readonly periods: readonly RetainerPeriodView[] }> {
    this.requireInternal(principal);
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const { projectIds } = await this.visible(r, context, principal, id);
      const rows = await this.repo.periods(r, org, id, MAX_PERIODS_LISTED);
      if (rows.length === 0) return { retainerId: id, periods: [] };
      const locks = await this.repo.locksOverlapping(
        r,
        org,
        rows[rows.length - 1]!.periodStart,
        rows[0]!.periodEnd,
      );
      const periods: RetainerPeriodView[] = [];
      for (const row of rows) {
        const used =
          row.state === 'open'
            ? await this.repo.usedMinutes(r, org, projectIds, row.periodStart, row.periodEnd)
            : row.usedMinutesCache;
        periods.push(periodView(row, used, overlapsLock(row, locks)));
      }
      return { retainerId: id, periods };
    });
  }

  async entries(
    context: TenantContext,
    principal: Principal,
    id: string,
    periodId: string,
    query: Record<string, unknown>,
  ): Promise<{
    readonly entries: readonly RetainerEntryView[];
    readonly nextCursor: string | null;
  }> {
    this.requireInternal(principal);
    const cursor = cursorOf(query['cursor']);
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const { projectIds } = await this.visible(r, context, principal, id);
      const period = await this.repo.findPeriod(r, org, id, periodId);
      if (period === null) throw notFound();
      const rows = await this.repo.entries(
        r,
        org,
        projectIds,
        period.periodStart,
        period.periodEnd,
        cursor,
        ENTRY_PAGE + 1,
      );
      const page = rows.slice(0, ENTRY_PAGE);
      return {
        entries: page.map((e) => ({
          id: e.id,
          date: e.spentOn,
          itemTitle: e.title,
          memberUserId: e.loggedBy,
          minutes: e.minutes,
          addedByHand: e.addedByHand,
        })),
        nextCursor: rows.length > ENTRY_PAGE ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  // ---- writes (finance.manage) ----

  async create(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
    body: unknown,
  ): Promise<RetainerView> {
    this.requireManage(principal, context);
    const input = validateRetainer(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      if (!(await this.repo.clientExists(tx, org, clientOrganizationId))) throw notFound();
      const projectIds = await this.checkProjects(
        tx,
        org,
        clientOrganizationId,
        input.projects,
        null,
      );
      const row: RetainerRow = {
        id: uuidv7(),
        organizationId: org,
        clientOrganizationId,
        name: input.name,
        period: input.period,
        hoursPerPeriod: input.hoursPerPeriod,
        amountPerPeriodMinor: input.amountPerPeriodMinor,
        currency: input.amountPerPeriodMinor === null ? null : await this.baseCurrency(tx, org),
        rollover: input.rollover,
        rolloverCapMinutes: input.rolloverCapMinutes,
        billingTiming: input.billingTiming,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        state: 'active',
        clientVisible: input.clientVisible,
        rateCardId: null,
        createdBy: context.userId,
        createdAt: at,
        updatedAt: at,
      };
      await this.repo.insert(tx, row);
      await this.repo.replaceProjects(tx, org, row.id, projectIds);
      // The period that holds `starts_on` is the first one; the worker roll opens the rest.
      const first = periodBounds(row.startsOn, input.period, 0);
      await this.repo.insertPeriod(tx, {
        id: uuidv7(),
        organizationId: org,
        retainerId: row.id,
        periodStart: first.periodStart,
        periodEnd: first.periodEnd,
        allowanceMinutes: allowanceOf(row.hoursPerPeriod),
        rolloverInMinutes: 0,
        usedMinutesCache: 0,
        overageMinutesCache: 0,
        state: 'open',
        invoiceId: null,
        closedAt: null,
      });
      await this.audited(tx, context, 'retainer.created', row.id, {
        client_organization_id: clientOrganizationId,
        period: row.period,
        hours_per_period: row.hoursPerPeriod,
        amount_per_period_minor: row.amountPerPeriodMinor,
        rollover: row.rollover,
        project_count: projectIds.length,
      });
      return retainerView(row, projectIds, true);
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<RetainerView> {
    this.requireManage(principal, context);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.find(tx, org, id, true);
      if (row === null) throw notFound();
      if (row.state === 'ended') throw conflict('retainer_ended');
      const patch = validateRetainerPatch(body, {
        ...row,
        amountPerPeriodMinor:
          row.amountPerPeriodMinor === null ? null : Number(row.amountPerPeriodMinor),
      });
      const change: RetainerChange = { updatedAt: at };
      const changes: { field: string; before: unknown; after: unknown }[] = [];
      for (const key of [
        'name',
        'hoursPerPeriod',
        'amountPerPeriodMinor',
        'rollover',
        'rolloverCapMinutes',
        'clientVisible',
        'endsOn',
      ] as const) {
        if (patch[key] === undefined || patch[key] === row[key]) continue;
        Object.assign(change, { [key]: patch[key] });
        changes.push({ field: key, before: row[key], after: patch[key] });
      }
      if (change.amountPerPeriodMinor != null && row.currency === null) {
        change.currency = await this.baseCurrency(tx, org);
      }
      let projectIds = (await this.repo.projectsOf(tx, org, [id])).get(id) ?? [];
      if (patch.projects !== undefined) {
        const next = await this.checkProjects(
          tx,
          org,
          row.clientOrganizationId,
          patch.projects,
          id,
        );
        await this.repo.replaceProjects(tx, org, id, next);
        changes.push({ field: 'projectCount', before: projectIds.length, after: next.length });
        projectIds = next;
      }
      await this.repo.update(tx, org, id, change);
      if (change.hoursPerPeriod !== undefined) {
        await this.repo.setOpenAllowance(tx, org, id, allowanceOf(change.hoursPerPeriod));
      }
      await this.options.audit.record(tx, context, {
        action: 'retainer.updated',
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { field_count: changes.length },
        changes,
      });
      return retainerView({ ...row, ...change }, projectIds, true);
    });
  }

  async transition(
    context: TenantContext,
    principal: Principal,
    id: string,
    event: RetainerEvent,
  ): Promise<RetainerView> {
    this.requireManage(principal, context);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.find(tx, org, id, true);
      if (row === null) throw notFound();
      const next = nextRetainerState(row.state, event);
      if (next === null) throw conflict(`invalid_transition:${row.state}->${event}`);
      await this.repo.update(tx, org, id, { state: next, updatedAt: at });
      const action: AuditAction =
        event === 'pause'
          ? 'retainer.paused'
          : event === 'resume'
            ? 'retainer.resumed'
            : 'retainer.ended';
      await this.audited(tx, context, action, id, { state: next, previous_state: row.state });
      const projectIds = (await this.repo.projectsOf(tx, org, [id])).get(id) ?? [];
      return retainerView({ ...row, state: next, updatedAt: at }, projectIds, true);
    });
  }

  // ---- portal (client_projection.read) ----

  async portalList(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly retainers: readonly PortalRetainerSummary[] }> {
    const clientOrg = this.portalClient(principal, null);
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const rows = (await this.repo.listForClient(r, org, clientOrg, true)).filter(
        (row) => row.state !== 'ended',
      );
      const projects = await this.repo.projectsOf(
        r,
        org,
        rows.map((row) => row.id),
      );
      const out: PortalRetainerSummary[] = [];
      for (const row of rows) {
        const summary = await this.portalSummary(r, org, row, projects.get(row.id) ?? []);
        if (summary !== null) out.push({ id: row.id, ...summary.view });
      }
      return { retainers: out };
    });
  }

  async portalGet(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<PortalRetainerView> {
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const row = await this.repo.find(r, org, id);
      if (row === null || !row.clientVisible) throw notFound();
      this.portalClient(principal, row.clientOrganizationId);
      const projectIds = (await this.repo.projectsOf(r, org, [id])).get(id) ?? [];
      const summary = await this.portalSummary(r, org, row, projectIds);
      if (summary === null) throw notFound();
      const entries = await this.repo.entries(
        r,
        org,
        projectIds,
        summary.view.periodStart,
        summary.view.periodEnd,
        null,
        PORTAL_ENTRY_LIMIT,
      );
      return {
        ...summary.view,
        entries: entries.map((e) => ({
          date: e.spentOn,
          // A project no longer shared with this client never lends its titles.
          taskTitle:
            e.projectId !== null && principal.projectIds.includes(e.projectId)
              ? clientTaskTitle(e)
              : INTERNAL_WORK_TITLE,
          hours: Math.round((e.minutes / 60) * 100) / 100,
          addedByHand: e.addedByHand,
        })),
      };
    });
  }

  /** The latest period of a retainer, projected. `null` when it has none. */
  private async portalSummary(
    r: TenantQueryRunner,
    org: string,
    row: RetainerRow,
    projectIds: readonly string[],
  ): Promise<{ readonly view: Omit<PortalRetainerView, 'entries'> } | null> {
    const period = (await this.repo.periods(r, org, row.id, 1))[0];
    if (period === undefined) return null;
    const used =
      period.state === 'open'
        ? await this.repo.usedMinutes(r, org, projectIds, period.periodStart, period.periodEnd)
        : period.usedMinutesCache;
    const offered = period.allowanceMinutes + period.rolloverInMinutes;
    const nextStart = addDays(period.periodEnd, 1);
    const renews =
      row.state === 'active' &&
      period.state === 'open' &&
      (row.endsOn === null || nextStart <= row.endsOn);
    return {
      view: {
        name: row.name,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        allowanceHours: hoursOf(offered),
        usedHours: hoursOf(used),
        remainingHours: hoursOf(Math.max(0, offered - used)),
        renewsOn: renews ? nextStart : null,
      },
    };
  }

  /**
   * The client principal's organization, when it may read the projection (and, for one retainer,
   * when the retainer is its own). Anything else is a 404, as for an unknown retainer.
   */
  private portalClient(principal: Principal, retainerClientOrg: string | null): string {
    const own = principal.clientOrganizationId;
    if (own === null || (retainerClientOrg !== null && retainerClientOrg !== own)) throw notFound();
    const allowed = authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId: null,
        audience: 'client_visible',
        clientOrganizationId: own,
        lifecycle: 'active',
      },
    }).allowed;
    if (!allowed) throw notFound();
    return own;
  }

  // ---- helpers ----

  /** The retainer and its projects when the caller may see it; otherwise 404. */
  private async visible(
    r: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<{ readonly row: RetainerRow; readonly projectIds: readonly string[] }> {
    const row = await this.repo.find(r, context.organizationId, id);
    if (row === null) throw notFound();
    const projectIds = (await this.repo.projectsOf(r, context.organizationId, [id])).get(id) ?? [];
    if (!this.mayView(principal, context, projectIds)) throw notFound();
    return { row, projectIds };
  }

  /**
   * The covered projects for a save: the named ones, or every project linked to the client. Each
   * must be linked to this client, and none may be covered by another not-ended retainer (409).
   */
  private async checkProjects(
    tx: TenantQueryRunner,
    org: string,
    clientOrganizationId: string,
    named: readonly string[] | null,
    exceptRetainerId: string | null,
  ): Promise<readonly string[]> {
    const linked = await this.repo.clientProjectIds(tx, org, clientOrganizationId);
    const projectIds = named ?? linked;
    if (projectIds.length === 0) throw invalid('projects', 'the client has no project to cover');
    if (projectIds.length > MAX_RETAINER_PROJECTS) {
      throw invalid('projects', `name at most ${String(MAX_RETAINER_PROJECTS)} projects`);
    }
    const linkedSet = new Set(linked);
    if (projectIds.some((p) => !linkedSet.has(p))) {
      throw invalid('projects', 'project_not_linked_to_client');
    }
    const covered = await this.repo.coveredElsewhere(tx, org, projectIds, exceptRetainerId);
    if (covered.length > 0) throw conflict('project_already_covered', 'projects');
    return projectIds;
  }

  private async baseCurrency(tx: TenantQueryRunner, org: string): Promise<string> {
    const profile = await this.options.finance.profile(tx, org);
    if (profile !== null) return profile.baseCurrency;
    return defaultProfile(await this.options.finance.organization(tx, org)).baseCurrency;
  }

  private mayView(
    principal: Principal,
    context: TenantContext,
    projectIds: readonly string[],
  ): boolean {
    return (
      this.allows(principal, context, FINANCE_VIEW, null) ||
      projectIds.some((p) => this.allows(principal, context, 'work.read', p))
    );
  }

  private allows(
    principal: Principal,
    context: TenantContext,
    capability: Capability,
    projectId: string | null,
  ): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private requireInternal(principal: Principal): void {
    if (principal.kind !== 'internal') throw forbidden('retainer.internal_only');
  }

  private requireManage(principal: Principal, context: TenantContext): void {
    this.requireInternal(principal);
    if (!this.allows(principal, context, FINANCE_MANAGE, null)) throw forbidden('retainer.manage');
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    objectId: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
      changes: [],
    });
  }
}
