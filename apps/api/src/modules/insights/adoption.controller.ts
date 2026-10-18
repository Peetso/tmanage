import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightsAdoptionRepository } from './adoption.repository.js';
import type {
  AdoptionApprovalHashRow,
  AdoptionChannelRow,
  AdoptionDatedWorkRow,
  AdoptionGapRow,
  AdoptionMeetingRow,
  AdoptionMemberRow,
  AdoptionProjectNameRow,
  AdoptionVersionHashRow,
  AdoptionWorkOwnerRow,
} from './adoption.repository.js';

/**
 * INS-06's HTTP surface — the org-wide adoption read (audit: "Insights Partial; INS-06 deferred").
 *
 * A separate controller and module from x89/x123's `InsightsController`, disjoint by file so the
 * insights slices land in parallel without a shared append point. It exposes one route,
 * `GET /v1/organizations/:orgSlug/insights/adoption`, behind `work.read` — the internal-read
 * capability the delivery-flow and workload reads already reuse, so INS-06 needs no new capability
 * and no `capabilities.ts` / role-grid edit (ADM-03 stays blocked).
 *
 * ## Org-level, and gated as one
 *
 * Unlike INS-05's per-project roll-up, adoption is a single org-level aggregate — a member count is
 * not decomposable per project. So the read is authorized **once at org level** (a `work.read`
 * `authorize()` with `projectId: null`), and a principal the check refuses gets a 403 rather than a
 * silently empty roll-up. `work.read` is internal-only (`capabilities.ts`), so a client principal is
 * refused here exactly as the route's `CapabilityGuard` refuses one — this is the relation half of
 * the same capability, the belt-and-braces the sibling reads apply.
 *
 * The window (`?days=`, default 30) is clamped to `[1, 90]`; a value outside that — an over-wide
 * window a caller might use to turn one read into an unbounded scan — is a 400, the FAST-PROTOCOL
 * Known-trap for this slice. The counts are computed from tenant-scoped reads, re-filtered to the
 * context's organization belt-and-braces before counting, so a cross-tenant row never contributes
 * and the read never returns another tenant's numbers.
 */

/** The adoption window's default and hard ceiling, in days. A wider window is a 400, not a clamp. */
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;

/** The data gaps the adoption view lists, in display order. */
export const ADOPTION_GAP_IDS = [
  'chat_work_untriaged',
  'client_files_internal',
  'requests_uncommitted',
] as const;
export type AdoptionGapId = (typeof ADOPTION_GAP_IDS)[number];

/**
 * One data gap: how many records carry it, across how many projects, and — when they all sit in
 * one project — that project's name, so the row can say "Atlas Relaunch" rather than "1 project".
 */
export interface InsightsAdoptionGapView {
  readonly id: AdoptionGapId;
  readonly count: number;
  readonly projectCount: number;
  readonly projectName: string | null;
}

/**
 * INS-06's read shape — the org-wide adoption and system-quality roll-up.
 *
 * `activeMembers` is the studio's current active memberships; `membersWithWork` is the distinct
 * people who created any work in the window; `meetingsHeld` is the meetings held in it.
 * `committedDate` counts work items created in the window (and the window before) that carry a
 * committed date; `channels` counts live channels and those no work item was ever created from;
 * `unhashedDeliverables` counts deliverables sent for approval whose hash does not match the stored
 * version (current and previous window); `decisionsRecorded` counts decisions logged and approvals
 * decided in the window; `gaps` lists the record gaps. `windowDays` echoes the validated window.
 * Computed, never stored. Paired in `e2e/contracts/api-web-shapes.ts` with the web shape.
 */
export interface InsightsAdoptionView {
  readonly windowDays: number;
  readonly activeMembers: number;
  readonly membersWithWork: number;
  readonly meetingsHeld: number;
  readonly committedDate: {
    readonly dated: number;
    readonly total: number;
    readonly previousDated: number;
    readonly previousTotal: number;
  };
  readonly channels: { readonly total: number; readonly withoutWork: number };
  readonly unhashedDeliverables: { readonly current: number; readonly previous: number };
  readonly decisionsRecorded: { readonly decisionLog: number; readonly approvals: number };
  readonly gaps: readonly InsightsAdoptionGapView[];
  readonly computedAt: string;
}

/** Everything the repository read for one roll-up, before the tenant filter and the counting. */
export interface AdoptionReads {
  readonly members: readonly AdoptionMemberRow[];
  readonly owners: readonly AdoptionWorkOwnerRow[];
  readonly meetings: readonly AdoptionMeetingRow[];
  readonly datedWork: readonly AdoptionDatedWorkRow[];
  readonly channels: readonly AdoptionChannelRow[];
  readonly channelsWithWork: readonly AdoptionChannelRow[];
  readonly approvalHashes: readonly AdoptionApprovalHashRow[];
  readonly versionHashes: readonly AdoptionVersionHashRow[];
  readonly decisionsLogged: readonly AdoptionGapRow[];
  readonly approvalsDecided: readonly AdoptionGapRow[];
  readonly gaps: Readonly<Record<AdoptionGapId, readonly AdoptionGapRow[]>>;
  readonly projectNames: readonly AdoptionProjectNameRow[];
}

/**
 * Turn the raw reads into the view. Pure: every row is re-filtered to `org` first (Known-trap:
 * scope before the count), then counted. Exported for the unit proof.
 */
export function rollUpAdoption(
  org: string,
  windowDays: number,
  reads: AdoptionReads,
  computedAt: Date,
): InsightsAdoptionView {
  const own = <T extends { readonly organizationId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => row.organizationId === org);

  const dated = own(reads.datedWork);
  const current = dated.filter((row) => row.inWindow);
  const previous = dated.filter((row) => !row.inWindow);

  const liveChannels = new Set(own(reads.channels).map((row) => row.conversationId));
  const fed = new Set(own(reads.channelsWithWork).map((row) => row.conversationId));
  const withoutWork = [...liveChannels].filter((id) => !fed.has(id)).length;

  const storedHash = new Map(
    own(reads.versionHashes).map((row) => [row.versionId, row.contentHash]),
  );
  const unhashed = (inWindow: boolean): number =>
    distinctCount(
      own(reads.approvalHashes)
        .filter((row) => row.inWindow === inWindow)
        .filter((row) => storedHash.get(row.deliverableVersionId) !== row.contentHash)
        .map((row) => row.deliverableId),
    );

  const names = new Map(own(reads.projectNames).map((row) => [row.projectId, row.name]));
  const gaps = ADOPTION_GAP_IDS.map((id): InsightsAdoptionGapView => {
    const rows = own(reads.gaps[id]);
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const only = projectIds.length === 1 ? projectIds[0] : undefined;
    return {
      id,
      count: rows.length,
      projectCount: projectIds.length,
      projectName: only === undefined ? null : (names.get(only) ?? null),
    };
  });

  return {
    windowDays,
    activeMembers: distinctCount(own(reads.members).map((row) => row.userId)),
    membersWithWork: distinctCount(own(reads.owners).map((row) => row.ownerUserId)),
    meetingsHeld: own(reads.meetings).length,
    committedDate: {
      dated: current.filter((row) => row.dated).length,
      total: current.length,
      previousDated: previous.filter((row) => row.dated).length,
      previousTotal: previous.length,
    },
    channels: { total: liveChannels.size, withoutWork },
    unhashedDeliverables: { current: unhashed(true), previous: unhashed(false) },
    decisionsRecorded: {
      decisionLog: own(reads.decisionsLogged).length,
      approvals: own(reads.approvalsDecided).length,
    },
    gaps,
    computedAt: computedAt.toISOString(),
  };
}

/**
 * Parse and validate the `?days=` window. Missing is the default 30; anything present must be an
 * integer in `[1, 90]` or the read is a 400 — an over-wide or nonsensical window is rejected, never
 * silently clamped, so a caller cannot quietly widen the scan the count runs over.
 */
function parseWindowDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) {
    throw new ApiError(400, 'validation_failed', 'The adoption window is invalid', [
      { field: 'days', message: `must be a whole number of days between 1 and ${MAX_WINDOW_DAYS}` },
    ]);
  }
  return value;
}

/** Distinct non-null count of a list of ids — the aggregation the roll-up is. */
function distinctCount(ids: readonly (string | null)[]): number {
  const seen = new Set<string>();
  for (const id of ids) if (id !== null) seen.add(id);
  return seen.size;
}

@Controller('v1/organizations/:orgSlug/insights')
export class InsightsAdoptionController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    // An explicit token: `emitDecoratorMetadata` is off (ADR-0003), so an un-annotated class
    // parameter is injected as `undefined` — the cause of the live 500 on this route.
    @Inject(InsightsAdoptionRepository) private readonly adoption: InsightsAdoptionRepository,
  ) {}

  /**
   * The org-wide adoption roll-up: active members, members who created work in the window, and
   * meetings held in it. Tenant-scoped by `orgSlug`; authorized once at org level (a `work.read`
   * refusal is a 403, not an empty roll-up); the window is clamped to `[1, 90]` (a wider one is a
   * 400). A pure read — no write, no new column.
   */
  @Get('adoption')
  @RequireCapability('work.read')
  async adoptionMetrics(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('days') days?: string,
  ): Promise<InsightsAdoptionView> {
    const windowDays = parseWindowDays(days);

    // Org-level relation check: the route's role ceiling gate mirrored as the belt-and-braces the
    // sibling reads apply. `work.read` is internal-only, so a client is refused here — a 403, not a
    // silently empty aggregate over an org-level internal read.
    if (!this.mayReadOrgAdoption(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'insights_adoption_denied',
      );
    }

    const now = new Date();
    const reads = await this.database.read(context, async (runner): Promise<AdoptionReads> => {
      // Sequential, not `Promise.all`: one connection is bound to this unit of work and mysql2 does
      // not multiplex a connection across concurrent queries.
      const repo = this.adoption;
      const members = await repo.listActiveMembers(runner, context);
      const owners = await repo.listRecentWorkOwners(runner, context, windowDays);
      const meetings = await repo.listMeetingsHeld(runner, context, windowDays);
      const datedWork = await repo.listDatedWork(runner, context, windowDays);
      const channels = await repo.listChannels(runner, context);
      const channelsWithWork = await repo.listChannelsWithWork(runner, context);
      const approvalHashes = await repo.listApprovalHashes(runner, context, windowDays);
      const versionIds = [...new Set(approvalHashes.map((row) => row.deliverableVersionId))];
      const versionHashes = await repo.listVersionHashes(runner, context, versionIds);
      const decisionsLogged = await repo.listDecisionsLogged(runner, context, windowDays);
      const approvalsDecided = await repo.listApprovalsDecided(runner, context, windowDays);
      const gaps = {
        chat_work_untriaged: await repo.listUntriagedChatWork(runner, context),
        client_files_internal: await repo.listClientFilesMarkedInternal(runner, context),
        requests_uncommitted: await repo.listRequestsAwaitingCommitment(runner, context),
      };
      const gapProjects = [
        ...new Set(Object.values(gaps).flatMap((rows) => rows.map((row) => row.projectId))),
      ];
      const projectNames = await repo.listProjectNames(runner, context, gapProjects);
      return {
        members,
        owners,
        meetings,
        datedWork,
        channels,
        channelsWithWork,
        approvalHashes,
        versionHashes,
        decisionsLogged,
        approvalsDecided,
        gaps,
        projectNames,
      };
    });

    return rollUpAdoption(context.organizationId, windowDays, reads, now);
  }

  /**
   * Whether this principal may read the org's adoption roll-up, judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the controller gated on the role. An internal role that holds `work.read` is allowed;
   * a client is refused because `work.read` is internal-only, and a cross-tenant principal by the
   * tenant check inside `authorize`.
   */
  private mayReadOrgAdoption(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * INS-06's wiring — a self-contained module registered from `app.module.ts` (the shared append
 * point) rather than folded into x89/x123's `InsightsModule`, so the insights slices stay
 * file-disjoint. The repository is a stateless collection of tenant-scoped reads, constructed here;
 * the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class InsightsAdoptionModule {
  static register(): DynamicModule {
    return {
      module: InsightsAdoptionModule,
      providers: [
        { provide: InsightsAdoptionRepository, useFactory: () => new InsightsAdoptionRepository() },
      ],
      controllers: [InsightsAdoptionController],
    };
  }
}
