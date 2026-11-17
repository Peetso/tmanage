import { ASSIGNABLE_INTERNAL_ROLES } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { isIanaTimeZone } from '../../../common/time-zone.js';
import {
  BILLING_MODE_SETTING_KEY,
  effectiveBillingMode,
  parseBillingMode,
  parseBillingModeOverride,
} from '../../billing/billing-mode.js';
import type { BillingMode } from '../../billing/billing-mode.js';
import { PLAN_IDS, PLAN_LIMITS, readPlanId } from '../../billing/plan-catalog.js';
import type { CatalogPlanId } from '../../billing/plan-catalog.js';
import {
  MAX_LOCALE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TIMEZONE_LENGTH,
  slugProblem,
} from '../../tenancy/organization-input.js';
import { optionalReason, requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type {
  PlatformAdminRepository,
  PlatformCompanyRow,
  PlatformSignupSourceRow,
} from '../platform-admin.repository.js';
import type {
  PlatformCompanyDetailView,
  PlatformCompanyView,
  PlatformOverviewView,
  RequestContext,
} from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import {
  isDuplicateSlug,
  ORG_AUDIT_ROWS,
  ORG_LIST_PAGE,
  PlatformOrganizationsRepository,
} from './organizations.repository.js';
import type { OrgListFilters, OrgRow, OrgStatusFilter } from './organizations.repository.js';

/**
 * Platform admin · Organizations (SPEC §6, A1–A5, A9) — the overview, search, the filtered list,
 * one organization's detail, its profile, and its plan, limits and storage. Lifecycle acts live in
 * `lifecycle.service.ts`, members in `members.service.ts`, settings in `org-settings.service.ts`.
 *
 * Reads take no reason; edits take an optional one; plan and billing mode, disconnecting storage
 * and the destructive list take a required one (SPEC P6). Every write leaves a platform audit row
 * that names the organization, in the same transaction as the change.
 *
 * The 0206 `companies…` routes keep answering (the AI registry and older screens name them).
 */

export type PlatformOrgStatus = 'active' | 'suspended' | 'deleted' | 'archived';
export type PlatformOrgHealth = 'good' | 'check' | 'failing';

/** One organization in a list, the header of A3, and the answer to every write. */
export interface PlatformOrgSummaryView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly plan: string | null;
  readonly storageBytes: number;
  readonly storageLimitBytes: number;
  readonly peopleLimit: number | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly status: PlatformOrgStatus;
  readonly health: PlatformOrgHealth;
  readonly failedRuns7d: number;
  readonly suspendedAt: string | null;
  readonly deletedAt: string | null;
  readonly purgeAfter: string | null;
}

export interface PlatformOrgCountsView {
  readonly all: number;
  readonly active: number;
  readonly suspended: number;
  readonly deleted: number;
  readonly archived: number;
}

export interface PlatformOrgListView {
  readonly organizations: readonly PlatformOrgSummaryView[];
  readonly nextCursor: string | null;
  readonly counts: PlatformOrgCountsView;
  readonly openSupportSessions: number;
}

export interface PlatformOrgAttentionView {
  readonly organizationId: string;
  readonly name: string;
  readonly kind: 'failing' | 'storage' | 'people' | 'purge';
  readonly level: 'check' | 'action';
  readonly detail: string;
}

export interface PlatformOrgActionView {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface PlatformOrgOverviewView {
  readonly companies: number;
  readonly suspendedCompanies: number;
  readonly people: number;
  readonly signups7d: number;
  readonly signups30d: number;
  readonly activeToday: number;
  readonly storageBytesUsed: number;
  readonly failedAutomationRuns7d: number;
  readonly outboxErrors: number;
  readonly computedAt: string;
  readonly deletedInWindow: number;
  readonly firstPurgeAt: string | null;
  readonly openSupportSessions: number;
  readonly firstSupportExpiry: string | null;
  readonly attention: readonly PlatformOrgAttentionView[];
  readonly recentActions: readonly PlatformOrgActionView[];
  /** ADTRACK. "Where sign-ups came from": the last 90 days, by `utm_*` combination. */
  readonly signupSources: readonly PlatformSignupSourceRow[];
}

export interface PlatformOrgSearchView {
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly people: readonly {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
  }[];
}

export interface PlatformOrgAuditView {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly actorEmail: string | null;
  readonly occurredAt: string;
}

export interface PlatformOrgDetailView {
  readonly organization: PlatformOrgSummaryView;
  readonly profile: {
    readonly defaultLocale: string;
    readonly timezone: string;
    readonly operatorNotes: string | null;
    readonly billingModeOverride: 'beta_free' | 'paid' | null;
  };
  readonly counts: {
    readonly invited: number;
    readonly openApprovals: number;
  };
  readonly integrations: readonly string[];
  readonly admins: readonly {
    readonly membershipId: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: string;
  }[];
  readonly supportSessions: readonly {
    readonly id: string;
    readonly adminName: string | null;
    readonly adminEmail: string | null;
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly reason: string | null;
    readonly actionsCount: number;
  }[];
  readonly audit: readonly PlatformOrgAuditView[];
  readonly platformActions: readonly PlatformOrgActionView[];
  readonly restoreDaysLeft: number | null;
  readonly retentionDays: number;
}

export interface PlatformOrgWriteView {
  readonly organization: PlatformOrgSummaryView;
}

export interface PlatformOrgLimitView {
  readonly plan: number | null;
  readonly override: number | null;
  readonly usage: number;
}

export interface PlatformOrgPlanView {
  readonly planId: string;
  readonly plans: readonly string[];
  readonly platformMode: 'beta_free' | 'paid';
  readonly override: 'inherit' | 'beta_free' | 'paid';
  readonly effectiveMode: 'beta_free' | 'paid';
  readonly subscription: {
    readonly status: string;
    readonly currentPeriodEnd: string | null;
  } | null;
  readonly limits: {
    readonly people: PlatformOrgLimitView;
    readonly activeProjects: PlatformOrgLimitView;
    readonly storageBytes: PlatformOrgLimitView;
  };
}

export interface PlatformOrgStorageView {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly connections: readonly {
    readonly id: string;
    readonly provider: string;
    readonly status: string;
    readonly accountEmail: string | null;
    readonly location: string | null;
    readonly connectedByEmail: string | null;
    readonly lastSyncAt: string | null;
  }[];
}

export interface PlatformOrgDeletedView {
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly deletedByEmail: string | null;
    readonly deletedAt: string;
    readonly purgeAfter: string | null;
    readonly daysLeft: number;
    readonly storageBytes: number;
  }[];
  readonly retentionDays: number;
}

/** The platform retention window for a deleted organization (PA-10 writes it). */
export const RETENTION_ORG_SETTING = 'retention.org_purge_days';
export const DEFAULT_ORG_RETENTION_DAYS = 30;
export const MAX_OPERATOR_NOTES = 4000;

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_FILTERS: readonly OrgStatusFilter[] = ['active', 'suspended', 'deleted', 'archived'];
const HEALTH_FILTERS: readonly PlatformOrgHealth[] = ['good', 'check', 'failing'];

/** Effective plan limits for a row: the override when set, else its plan's. */
export function limitsFor(
  row: Pick<OrgRow, 'planId' | 'peopleLimit' | 'activeProjectsLimit' | 'storageBytesLimit'>,
) {
  const plan = PLAN_LIMITS[readPlanId(row.planId)];
  return {
    plan,
    people: row.peopleLimit ?? plan.people,
    activeProjects: row.activeProjectsLimit ?? plan.activeProjects,
    // 57-13r: 0 = no plan figure (Enterprise, by agreement); the storage health rules skip 0.
    storageBytes: row.storageBytesLimit ?? plan.storageBytes ?? 0,
  };
}

export function statusOf(
  row: Pick<OrgRow, 'deletedAt' | 'archivedAt' | 'suspendedAt'>,
): PlatformOrgStatus {
  if (row.deletedAt) return 'deleted';
  if (row.archivedAt) return 'archived';
  if (row.suspendedAt) return 'suspended';
  return 'active';
}

/** Failing: a failed automation run in 7 days. Check: storage over 90 % or people over the limit. */
export function healthOf(row: OrgRow): PlatformOrgHealth {
  if (row.failedRuns > 0) return 'failing';
  const limits = limitsFor(row);
  if (limits.storageBytes > 0 && row.storageBytes > limits.storageBytes * 0.9) return 'check';
  if (limits.people !== null && row.people > limits.people) return 'check';
  return 'good';
}

export function toSummary(row: OrgRow): PlatformOrgSummaryView {
  const limits = limitsFor(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerEmail: row.ownerEmail,
    people: row.people,
    clients: row.clients,
    projects: row.projects,
    plan: row.planId,
    storageBytes: row.storageBytes,
    storageLimitBytes: limits.storageBytes,
    peopleLimit: limits.people,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    status: statusOf(row),
    health: healthOf(row),
    failedRuns7d: row.failedRuns,
    suspendedAt: iso(row.suspendedAt),
    deletedAt: iso(row.deletedAt),
    purgeAfter: iso(row.purgeAfter),
  };
}

export function daysLeft(purgeAfter: Date | null, now: Date): number {
  if (!purgeAfter) return 0;
  return Math.max(0, Math.ceil((purgeAfter.getTime() - now.getTime()) / DAY_MS));
}

export function encodeCursor(row: Pick<OrgRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): OrgListFilters['cursor'] {
  if (typeof raw !== 'string' || raw === '') return null;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new ApiError(
      400,
      'validation_failed',
      'This list position is not valid. Reload the list.',
      [{ field: 'cursor', message: 'invalid' }],
    );
  }
  return { createdAt, id };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function dateParam(raw: unknown, field: string): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'validation_failed', 'Choose a valid date.', [
      { field, message: 'date' },
    ]);
  }
  return parsed;
}

function stringParam(raw: unknown, max = 190): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, max) : null;
}

export interface ListQuery {
  readonly q?: unknown;
  readonly status?: unknown;
  readonly plan?: unknown;
  readonly health?: unknown;
  readonly integration?: unknown;
  readonly createdFrom?: unknown;
  readonly createdTo?: unknown;
  readonly activeFrom?: unknown;
  readonly activeTo?: unknown;
  readonly cursor?: unknown;
}

export interface ProfileInput {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly defaultLocale?: unknown;
  readonly timezone?: unknown;
  readonly operatorNotes?: unknown;
  readonly reason?: unknown;
}

export interface PlanInput {
  readonly planId?: unknown;
  readonly billingModeOverride?: unknown;
  readonly reason?: unknown;
}

export interface LimitsInput {
  readonly people?: unknown;
  readonly activeProjects?: unknown;
  readonly storageBytes?: unknown;
  readonly reason?: unknown;
}

/** A limit field: absent keeps nothing (null = plan default), else a whole number ≥ 0. */
export function parseLimit(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(
      400,
      'validation_failed',
      'Limits are whole numbers, or blank for the plan default.',
      [{ field, message: 'whole number ≥ 0' }],
    );
  }
  return value;
}

export class PlatformOrganizationsService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    /** Optional so the 0206 callers (and their tests) that use only `companies…` still build it. */
    private readonly organizationsRepository: PlatformOrganizationsRepository | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get orgs(): PlatformOrganizationsRepository {
    if (!this.organizationsRepository)
      throw new Error('PlatformOrganizationsRepository not provided');
    return this.organizationsRepository;
  }

  // ── A1 overview, search ──────────────────────────────────────────────────

  async overview(context: RequestContext): Promise<PlatformOrgOverviewView> {
    const now = this.now();
    const base = await this.repository.overview(now, context.correlationId);
    const counts = await this.orgs.statusCounts(context.correlationId);
    const sessions = await this.orgs.openSupportSessions(now, context.correlationId);
    const rows = await this.orgs.list(listFilters({ limit: 200 }), now, context.correlationId);
    const actions = await this.orgs.recentPlatformActions(context.correlationId);
    return {
      ...base,
      companies: counts.active + counts.suspended,
      suspendedCompanies: counts.suspended,
      computedAt: now.toISOString(),
      deletedInWindow: counts.deleted,
      firstPurgeAt: iso(counts.firstPurgeAt),
      openSupportSessions: sessions.open,
      firstSupportExpiry: iso(sessions.firstExpiry),
      attention: attentionFor(rows, now),
      recentActions: actions.map(toActionItem),
    };
  }

  async search(rawQ: unknown, context: RequestContext): Promise<PlatformOrgSearchView> {
    const q = stringParam(rawQ, 190);
    if (q === null || q.length < 2) return { organizations: [], people: [] };
    const organizations = await this.orgs.search(q, context.correlationId);
    const people = await this.repository.searchPeople(q, context.correlationId);
    return {
      organizations,
      people: people.people.slice(0, 8).map((person) => ({
        userId: person.userId,
        email: person.email,
        displayName: person.displayName,
      })),
    };
  }

  // ── A2 list ──────────────────────────────────────────────────────────────

  async list(query: ListQuery, context: RequestContext): Promise<PlatformOrgListView> {
    const now = this.now();
    const status = stringParam(query.status);
    if (
      status !== null &&
      status !== 'all' &&
      !STATUS_FILTERS.includes(status as OrgStatusFilter)
    ) {
      throw new ApiError(400, 'validation_failed', 'Choose a listed status.', [
        { field: 'status', message: 'unknown' },
      ]);
    }
    const plan = stringParam(query.plan);
    if (plan !== null && plan !== 'any' && !(PLAN_IDS as readonly string[]).includes(plan)) {
      throw new ApiError(400, 'validation_failed', 'Choose a listed plan.', [
        { field: 'plan', message: 'unknown' },
      ]);
    }
    const health = stringParam(query.health);
    if (
      health !== null &&
      health !== 'any' &&
      !HEALTH_FILTERS.includes(health as PlatformOrgHealth)
    ) {
      throw new ApiError(400, 'validation_failed', 'Choose a listed health.', [
        { field: 'health', message: 'unknown' },
      ]);
    }
    const filters = listFilters({
      q: stringParam(query.q),
      status: status === null || status === 'all' ? null : (status as OrgStatusFilter),
      plan: plan === null || plan === 'any' ? null : plan,
      createdFrom: dateParam(query.createdFrom, 'createdFrom'),
      createdTo: dateParam(query.createdTo, 'createdTo'),
      activeFrom: dateParam(query.activeFrom, 'activeFrom'),
      activeTo: dateParam(query.activeTo, 'activeTo'),
      cursor: decodeCursor(query.cursor),
      limit: ORG_LIST_PAGE + 1,
    });
    const rows = await this.orgs.list(filters, now, context.correlationId);
    const page = rows.slice(0, ORG_LIST_PAGE);
    const last = page[page.length - 1];
    const counts = await this.orgs.statusCounts(context.correlationId);
    const sessions = await this.orgs.openSupportSessions(now, context.correlationId);
    const summaries = page
      .map(toSummary)
      .filter((row) => health === null || health === 'any' || row.health === health);
    return {
      organizations: summaries,
      nextCursor: rows.length > ORG_LIST_PAGE && last ? encodeCursor(last) : null,
      counts: {
        all: counts.total,
        active: counts.active,
        suspended: counts.suspended,
        deleted: counts.deleted,
        archived: counts.archived,
      },
      openSupportSessions: sessions.open,
    };
  }

  // ── A3 detail ────────────────────────────────────────────────────────────

  async detail(rawId: unknown, context: RequestContext): Promise<PlatformOrgDetailView> {
    const now = this.now();
    const row = await this.require(rawId, context);
    const counts = await this.orgs.detailCounts(row.id, now, context.correlationId);
    const connections = await this.orgs.connections(row.id, context.correlationId);
    const members = await this.orgs.members(row.id, context.correlationId);
    const sessions = await this.orgs.supportSessionsFor(row.id, now, context.correlationId);
    const audit = await this.orgs.orgAudit(row.id, ORG_AUDIT_ROWS, context.correlationId);
    const actions = await this.orgs.platformActionsFor(
      row.id,
      ORG_AUDIT_ROWS,
      context.correlationId,
    );
    const retentionDays = await this.retentionDays(context);
    return {
      organization: toSummary(row),
      profile: {
        defaultLocale: row.defaultLocale,
        timezone: row.timezone,
        operatorNotes: row.operatorNotes,
        billingModeOverride: parseBillingModeOverride(row.billingModeOverride),
      },
      counts: { invited: counts.invited, openApprovals: counts.openApprovals },
      integrations: connections
        .filter((connection) => connection.status === 'connected')
        .map((connection) => connection.provider),
      admins: members.internal
        .filter((member) => member.role === 'owner' || member.role === 'org_admin')
        .map((member) => ({
          membershipId: member.id,
          displayName: member.displayName,
          email: member.email,
          role: member.role,
        })),
      supportSessions: sessions.map((session) => ({
        id: session.id,
        adminName: session.adminName,
        adminEmail: session.adminEmail,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        reason: session.reason,
        actionsCount: session.actionsCount,
      })),
      audit: audit.map((event) => ({
        id: event.id,
        action: event.action,
        objectType: event.objectType,
        result: event.result,
        actorEmail: event.actorEmail,
        occurredAt: event.createdAt.toISOString(),
      })),
      platformActions: actions.map(toActionItem),
      restoreDaysLeft: row.deletedAt ? daysLeft(row.purgeAfter, now) : null,
      retentionDays,
    };
  }

  async auditLog(
    rawId: unknown,
    context: RequestContext,
  ): Promise<{
    readonly audit: readonly PlatformOrgAuditView[];
    readonly platformActions: readonly PlatformOrgActionView[];
  }> {
    const row = await this.require(rawId, context);
    const audit = await this.orgs.orgAudit(row.id, 100, context.correlationId);
    const actions = await this.orgs.platformActionsFor(row.id, 100, context.correlationId);
    return {
      audit: audit.map((event) => ({
        id: event.id,
        action: event.action,
        objectType: event.objectType,
        result: event.result,
        actorEmail: event.actorEmail,
        occurredAt: event.createdAt.toISOString(),
      })),
      platformActions: actions.map(toActionItem),
    };
  }

  // ── A4 profile ───────────────────────────────────────────────────────────

  async updateProfile(
    actor: PlatformAdminActor,
    rawId: unknown,
    input: ProfileInput,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const row = await this.require(rawId, context);
    const reason = optionalReason(input?.reason);
    const name = input.name === undefined ? row.name : String(input.name ?? '').trim();
    if (name === '' || name.length > MAX_NAME_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'Type the organization name.', [
        { field: 'name', message: 'required' },
      ]);
    }
    const slug =
      input.slug === undefined
        ? row.slug
        : String(input.slug ?? '')
            .trim()
            .toLowerCase();
    if (slug !== row.slug) {
      const problem = slugProblem(slug);
      if (problem)
        throw new ApiError(400, 'validation_failed', problem, [
          { field: 'slug', message: problem },
        ]);
      const holder = await this.orgs.slugOwner(slug, context.correlationId);
      if (holder !== null && holder !== row.id) throw slugTaken();
    }
    const defaultLocale = boundedText(
      input.defaultLocale,
      row.defaultLocale,
      MAX_LOCALE_LENGTH,
      'defaultLocale',
    );
    const timezone = boundedText(input.timezone, row.timezone, MAX_TIMEZONE_LENGTH, 'timezone');
    if (timezone !== row.timezone && !isIanaTimeZone(timezone)) {
      throw new ApiError(400, 'validation_failed', 'That is not a time zone we recognise.', [
        { field: 'timezone', message: 'must be an IANA time zone' },
      ]);
    }
    let operatorNotes = row.operatorNotes;
    if (input.operatorNotes !== undefined) {
      const notes = input.operatorNotes === null ? '' : String(input.operatorNotes).trim();
      if (notes.length > MAX_OPERATOR_NOTES) {
        throw new ApiError(400, 'validation_failed', 'Keep the notes under 4000 characters.', [
          { field: 'operatorNotes', message: 'too long' },
        ]);
      }
      operatorNotes = notes === '' ? null : notes;
    }
    const before = {
      name: row.name,
      slug: row.slug,
      defaultLocale: row.defaultLocale,
      timezone: row.timezone,
    };
    const after = { name, slug, defaultLocale, timezone };
    try {
      await this.orgs.write(
        row.id,
        {
          ...platformAuditFor(actor, context, {
            action: 'platform.organization_updated',
            targetType: 'organization',
            targetId: row.id,
            targetLabel: name,
            organizationId: row.id,
            reason,
          }),
          beforeJson: JSON.stringify({ ...before, operatorNotesChanged: false }),
          afterJson: JSON.stringify({
            ...after,
            operatorNotesChanged: operatorNotes !== row.operatorNotes,
          }),
        },
        (tx) =>
          PlatformOrganizationsRepository.updateProfile(tx, row.id, { ...after, operatorNotes }),
      );
    } catch (error) {
      if (isDuplicateSlug(error)) throw slugTaken();
      throw error;
    }
    return this.written(row.id, context);
  }

  // ── A5 plan, limits, storage ─────────────────────────────────────────────

  async plan(rawId: unknown, context: RequestContext): Promise<PlatformOrgPlanView> {
    const row = await this.require(rawId, context);
    const platformMode = await this.platformMode(context);
    const subscription = await this.orgs.subscription(row.id, context.correlationId);
    const planId = readPlanId(row.planId);
    const plan = PLAN_LIMITS[planId];
    const override = parseBillingModeOverride(row.billingModeOverride);
    return {
      planId,
      plans: [...PLAN_IDS],
      platformMode,
      override: override ?? 'inherit',
      effectiveMode: effectiveBillingMode(platformMode, override),
      subscription: subscription
        ? { status: subscription.status, currentPeriodEnd: iso(subscription.currentPeriodEnd) }
        : null,
      limits: {
        people: { plan: plan.people, override: row.peopleLimit, usage: row.people },
        activeProjects: {
          plan: plan.activeProjects,
          override: row.activeProjectsLimit,
          usage: row.projects,
        },
        storageBytes: {
          plan: plan.storageBytes,
          override: row.storageBytesLimit,
          usage: row.storageBytes,
        },
      },
    };
  }

  async setPlan(
    actor: PlatformAdminActor,
    rawId: unknown,
    input: PlanInput,
    context: RequestContext,
  ): Promise<PlatformOrgPlanView> {
    const reason = requireReason(input?.reason);
    const row = await this.require(rawId, context);
    let planId: CatalogPlanId | null = null;
    if (input.planId !== undefined && input.planId !== null) {
      if (!(PLAN_IDS as readonly unknown[]).includes(input.planId)) {
        throw new ApiError(400, 'validation_failed', 'Choose a listed plan.', [
          { field: 'planId', message: 'unknown' },
        ]);
      }
      planId = input.planId as CatalogPlanId;
    }
    const rawOverride = input.billingModeOverride ?? 'inherit';
    if (rawOverride !== 'inherit' && rawOverride !== 'beta_free' && rawOverride !== 'paid') {
      throw new ApiError(400, 'validation_failed', 'Choose inherit, beta_free or paid.', [
        { field: 'billingModeOverride', message: 'unknown' },
      ]);
    }
    const override = rawOverride === 'inherit' ? null : rawOverride;
    await this.orgs.write(
      row.id,
      {
        ...platformAuditFor(actor, context, {
          action: 'platform.organization_plan_changed',
          targetType: 'organization',
          targetId: row.id,
          targetLabel: row.name,
          organizationId: row.id,
          reason,
        }),
        beforeJson: JSON.stringify({
          planId: row.planId,
          billingModeOverride: row.billingModeOverride,
        }),
        afterJson: JSON.stringify({ planId: planId ?? row.planId, billingModeOverride: override }),
      },
      (tx) => PlatformOrganizationsRepository.setPlan(tx, row.id, planId, override),
    );
    return this.plan(row.id, context);
  }

  async setLimits(
    actor: PlatformAdminActor,
    rawId: unknown,
    input: LimitsInput,
    context: RequestContext,
  ): Promise<PlatformOrgPlanView> {
    const reason = optionalReason(input?.reason);
    const row = await this.require(rawId, context);
    const limits = {
      people: parseLimit(input.people, 'people'),
      activeProjects: parseLimit(input.activeProjects, 'activeProjects'),
      storageBytes: parseLimit(input.storageBytes, 'storageBytes'),
    };
    await this.orgs.write(
      row.id,
      {
        ...platformAuditFor(actor, context, {
          action: 'platform.organization_limits_changed',
          targetType: 'organization',
          targetId: row.id,
          targetLabel: row.name,
          organizationId: row.id,
          reason,
        }),
        beforeJson: JSON.stringify({
          people: row.peopleLimit,
          activeProjects: row.activeProjectsLimit,
          storageBytes: row.storageBytesLimit,
        }),
        afterJson: JSON.stringify(limits),
      },
      (tx) => PlatformOrganizationsRepository.setLimits(tx, row.id, limits, actor.account.userId),
    );
    return this.plan(row.id, context);
  }

  async storage(rawId: unknown, context: RequestContext): Promise<PlatformOrgStorageView> {
    const row = await this.require(rawId, context);
    const connections = await this.orgs.connections(row.id, context.correlationId);
    return {
      usedBytes: row.storageBytes,
      limitBytes: limitsFor(row).storageBytes,
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        status: connection.status,
        accountEmail: connection.accountEmail,
        location: connection.location,
        connectedByEmail: connection.connectedByEmail,
        lastSyncAt: iso(connection.lastSyncAt),
      })),
    };
  }

  async recountStorage(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgStorageView> {
    const reason = optionalReason(body?.reason);
    const row = await this.require(rawId, context);
    await this.orgs.write(
      row.id,
      platformAuditFor(actor, context, {
        action: 'platform.organization_storage_recounted',
        targetType: 'organization',
        targetId: row.id,
        targetLabel: row.name,
        organizationId: row.id,
        reason,
      }),
      (tx) => PlatformOrganizationsRepository.recount(tx, row.id),
    );
    return this.storage(row.id, context);
  }

  async disconnectStorage(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawConnectionId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgStorageView> {
    const reason = requireReason(body?.reason);
    const connectionId = requireId(rawConnectionId);
    const row = await this.require(rawId, context);
    const done = await this.orgs.write(
      row.id,
      platformAuditFor(actor, context, {
        action: 'platform.organization_storage_disconnected',
        targetType: 'organization',
        targetId: row.id,
        targetLabel: row.name,
        organizationId: row.id,
        reason,
      }),
      async (tx) => {
        const changed = await PlatformOrganizationsRepository.disconnect(tx, row.id, connectionId);
        if (!changed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
        return changed;
      },
    );
    void done;
    return this.storage(row.id, context);
  }

  // ── A9 deleted ───────────────────────────────────────────────────────────

  async deleted(context: RequestContext): Promise<PlatformOrgDeletedView> {
    const now = this.now();
    const rows = await this.orgs.deleted(now, context.correlationId);
    return {
      organizations: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        deletedByEmail: row.deletedByEmail,
        deletedAt: (row.deletedAt ?? now).toISOString(),
        purgeAfter: iso(row.purgeAfter),
        daysLeft: daysLeft(row.purgeAfter, now),
        storageBytes: row.storageBytes,
      })),
      retentionDays: await this.retentionDays(context),
    };
  }

  // ── Shared ───────────────────────────────────────────────────────────────

  async require(rawId: unknown, context: RequestContext): Promise<OrgRow> {
    const id = requireId(rawId);
    const row = await this.orgs.find(id, this.now(), context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }

  async written(id: string, context: RequestContext): Promise<PlatformOrgWriteView> {
    const row = await this.orgs.find(id, this.now(), context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { organization: toSummary(row) };
  }

  async retentionDays(context: RequestContext): Promise<number> {
    const raw = await this.orgs.readSetting(RETENTION_ORG_SETTING, context.correlationId);
    const days = Number(raw);
    return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : DEFAULT_ORG_RETENTION_DAYS;
  }

  async platformMode(context: RequestContext): Promise<BillingMode> {
    const raw = await this.orgs.readSetting(BILLING_MODE_SETTING_KEY, context.correlationId);
    const stored = parseBillingModeOverride(raw);
    return stored ?? parseBillingMode(process.env['BILLING_MODE']);
  }

  // ── 0206 `companies…` routes, kept for the AI registry and older callers ─

  async companies(
    rawSearch: unknown,
    context: RequestContext,
  ): Promise<{ readonly companies: readonly PlatformCompanyView[] }> {
    const search = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 190) : '';
    const rows = await this.repository.listCompanies(
      search === '' ? null : search,
      context.correlationId,
    );
    return { companies: rows.map(toCompanyView) };
  }

  async company(rawId: unknown, context: RequestContext): Promise<PlatformCompanyDetailView> {
    const id = requireId(rawId);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const events = await this.repository.listCompanyAudit(id, context.correlationId);
    return {
      company: toCompanyView(row),
      recentAdminEvents: events.map((event) => ({
        id: event.id,
        action: event.action,
        objectType: event.objectType,
        result: event.result,
        occurredAt: event.createdAt.toISOString(),
      })),
    };
  }

  /** Suspension and reactivation (0206), reason required. A3/A7 call them through `lifecycle`. */
  async setSuspended(
    actor: PlatformAdminActor,
    rawId: unknown,
    suspend: boolean,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly company: PlatformCompanyView }> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const already = row.suspendedAt !== null;
    if (already === suspend) {
      throw new ApiError(
        409,
        'conflict',
        suspend ? 'This company is already suspended.' : 'This company is not suspended.',
      );
    }
    await this.repository.setSuspended(
      id,
      suspend,
      platformAuditFor(actor, context, {
        action: suspend ? 'platform.company_suspended' : 'platform.company_reactivated',
        targetType: 'organization',
        targetId: id,
        targetLabel: row.name,
        organizationId: id,
        reason,
      }),
    );
    const updated = await this.repository.findCompany(id, context.correlationId);
    return { company: toCompanyView(updated ?? row) };
  }
}

/** Kept for the 0206 `GET overview` callers that read only the base tiles. */
export type { PlatformOverviewView };

/** The roles an operator may give from A6 (custom roles are PA-04's page). */
export const PLATFORM_ASSIGNABLE_ROLES = ASSIGNABLE_INTERNAL_ROLES;

export function listFilters(partial: Partial<OrgListFilters>): OrgListFilters {
  return {
    q: null,
    status: null,
    plan: null,
    createdFrom: null,
    createdTo: null,
    activeFrom: null,
    activeTo: null,
    cursor: null,
    limit: ORG_LIST_PAGE,
    ...partial,
  };
}

export function attentionFor(
  rows: readonly OrgRow[],
  now: Date,
): readonly PlatformOrgAttentionView[] {
  const items: PlatformOrgAttentionView[] = [];
  for (const row of rows) {
    const limits = limitsFor(row);
    if (row.deletedAt && row.purgeAfter) {
      const days = daysLeft(row.purgeAfter, now);
      if (days <= 7) {
        items.push({
          organizationId: row.id,
          name: row.name,
          kind: 'purge',
          level: 'check',
          detail: `purge in ${days} d`,
        });
      }
      continue;
    }
    if (row.failedRuns > 0) {
      items.push({
        organizationId: row.id,
        name: row.name,
        kind: 'failing',
        level: 'action',
        detail: `${row.failedRuns} failed runs · 7 d`,
      });
    } else if (limits.storageBytes > 0 && row.storageBytes > limits.storageBytes * 0.9) {
      items.push({
        organizationId: row.id,
        name: row.name,
        kind: 'storage',
        level: row.storageBytes > limits.storageBytes ? 'action' : 'check',
        detail: `storage ${Math.round((row.storageBytes / limits.storageBytes) * 100)} %`,
      });
    } else if (limits.people !== null && row.people > limits.people) {
      items.push({
        organizationId: row.id,
        name: row.name,
        kind: 'people',
        level: 'check',
        detail: `${row.people} / ${limits.people} seats`,
      });
    }
  }
  return items.slice(0, 6);
}

function toActionItem(row: {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}): PlatformOrgActionView {
  return {
    id: row.id,
    actorEmail: row.actorEmail,
    action: row.action,
    targetLabel: row.targetLabel,
    organizationId: row.organizationId,
    reason: row.reason,
    occurredAt: row.createdAt.toISOString(),
  };
}

function boundedText(raw: unknown, fallback: string, max: number, field: string): string {
  if (raw === undefined) return fallback;
  const value = String(raw ?? '').trim();
  if (value === '' || value.length > max) {
    throw new ApiError(400, 'validation_failed', 'Choose a value from the list.', [
      { field, message: 'invalid' },
    ]);
  }
  return value;
}

export function slugTaken(): ApiError {
  return new ApiError(409, 'conflict', 'Another organization already uses this address.', [
    { field: 'slug', message: 'taken' },
  ]);
}

export function toCompanyView(row: PlatformCompanyRow): PlatformCompanyView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerEmail: row.ownerEmail,
    people: row.people,
    clients: row.clients,
    projects: row.projects,
    plan: row.planId,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    status: row.archivedAt ? 'archived' : row.suspendedAt ? 'suspended' : 'active',
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
  };
}
