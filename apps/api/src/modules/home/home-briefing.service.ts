import {
  SIGNAL_RULES,
  assembleBriefing,
  briefingLinePath,
  briefingReasonOf,
  briefingSignalVisible,
  briefingSubjectKey,
  briefingViewerBase,
} from '@tmanage/domain';
import type {
  BriefingAmount,
  BriefingAudience,
  BriefingReason,
  BriefingGroup,
  BriefingSource,
  BriefingViewer,
  BriefingViewerBase,
  Capability,
  Principal,
  SignalBriefingGroup,
  SignalRuleKey,
  SignalSubjectType,
  SignalThresholdUnit,
} from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { HomeBriefingRepository } from './home-briefing.repository.js';

/**
 * 62-A1b (B11) — the business briefing on Home: what the last signals sweep found that this
 * viewer may act on, grouped (`buildBriefing`, shared with the morning mail). Rows and rules only:
 * no model is called anywhere on this path.
 *
 * - Clients and internal guests get the calm 404: the briefing is not theirs to know about.
 * - Owner and admins (org-wide scope) see the company; a lead sees their projects and people;
 *   money lines need `finance.view`; a member who leads nothing gets `audience: 'none'` and the
 *   card is not drawn (FIGMA-D fix 11).
 * - "As of" is the last finished sweep; before the first one there is nothing to list.
 */

export interface HomeBriefingView {
  readonly audience: BriefingAudience;
  /** ISO time of the last finished sweep; null before the first. */
  readonly asOf: string | null;
  readonly groups: readonly BriefingGroup[];
}

/**
 * 62-28 — one open alert as "Explain this" reads it: the stored figures, the reason, the record it
 * is about and where it opens. Rows only; the explanation itself is the chat's Low turn.
 */
export interface BriefingSignalView {
  readonly signalId: string;
  readonly rule: SignalRuleKey;
  readonly group: SignalBriefingGroup;
  readonly money: boolean;
  readonly subjectType: SignalSubjectType;
  readonly subjectId: string;
  readonly projectId: string | null;
  readonly measure: number;
  readonly threshold: number;
  readonly unit: SignalThresholdUnit;
  readonly reason: BriefingReason;
  readonly title: string | null;
  readonly context: string | null;
  readonly amount: BriefingAmount | null;
  readonly category: string | null;
  readonly path: string;
  /** ISO time of the sweep that found it. */
  readonly asOf: string;
}

const SIGNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const signalNotFound = (cause: string) =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, cause);

/** The principal's briefing base (domain `briefingViewerBase`: the card and the mail share it). */
export function briefingBaseOf(context: TenantContext, principal: Principal): BriefingViewerBase {
  return briefingViewerBase({
    hasOrgWideScope: principal.hasOrgWideScope,
    holds: (capability: Capability) => context.capabilities.includes(capability),
    projectIds: principal.projectIds,
    membershipId: principal.membershipId,
  });
}

/** The full viewer once the team is known (used by the project and client summaries too). */
export function briefingViewerOf(
  context: TenantContext,
  principal: Principal,
  teamMembershipIds: ReadonlySet<string> = new Set(),
): BriefingViewer {
  const { membershipId: _membershipId, ...base } = briefingBaseOf(context, principal);
  return { ...base, teamMembershipIds };
}

function refuseOutsiders(principal: Principal): void {
  if (principal.kind !== 'internal' || principal.role === 'guest') {
    throw new ApiError(
      404,
      'not_found',
      MESSAGES.notFound,
      undefined,
      'home_briefing:not_internal',
    );
  }
}

export class HomeBriefingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: HomeBriefingRepository,
  ) {}

  async briefingOf(context: TenantContext, principal: Principal): Promise<HomeBriefingView> {
    refuseOutsiders(principal);
    const base = briefingBaseOf(context, principal);
    const briefing = await this.database.read(context, (runner) =>
      assembleBriefing(this.sourceOf(runner, context), base),
    );
    return {
      audience: briefing.audience,
      asOf: briefing.asOf?.toISOString() ?? null,
      groups: briefing.groups,
    };
  }

  /**
   * 62-28: one open signal of the last sweep, with the card's rule for who may see it (same
   * viewer, same per-signal check, same subject resolution). Anything else is the calm 404: an
   * unknown id, a closed or older signal, one the viewer may not see, a record gone.
   */
  async signalOf(
    context: TenantContext,
    principal: Principal,
    signalId: string,
  ): Promise<BriefingSignalView> {
    refuseOutsiders(principal);
    if (!SIGNAL_ID.test(signalId)) throw signalNotFound('home_briefing:signal_id');
    const base = briefingBaseOf(context, principal);
    return this.database.read(context, async (runner) => {
      const source = this.sourceOf(runner, context);
      const team = base.companyWide
        ? new Set<string>()
        : await source.team([...base.projectIds], base.membershipId);
      const viewer: BriefingViewer = {
        companyWide: base.companyWide,
        finance: base.finance,
        projectIds: base.projectIds,
        teamMembershipIds: team,
      };
      const sweptAt = await source.lastSweep();
      if (sweptAt === null) throw signalNotFound('home_briefing:no_sweep');
      const id = signalId.toLowerCase();
      const signal = (await source.openSignals(sweptAt)).find(
        (open) => open.signalId.toLowerCase() === id,
      );
      if (signal === undefined || !briefingSignalVisible(signal, viewer)) {
        throw signalNotFound('home_briefing:signal_not_visible');
      }
      const subject = (await source.subjects([signal])).get(
        briefingSubjectKey(signal.subjectType, signal.subjectId),
      );
      if (subject === undefined) throw signalNotFound('home_briefing:subject_gone');
      const rule = SIGNAL_RULES[signal.rule];
      return {
        signalId: signal.signalId,
        rule: signal.rule,
        group: rule.briefingGroup,
        money: rule.money,
        subjectType: signal.subjectType,
        subjectId: signal.subjectId,
        projectId: signal.projectId,
        measure: signal.measure,
        threshold: signal.threshold,
        unit: rule.threshold.unit,
        reason: briefingReasonOf({
          rule: signal.rule,
          measure: signal.measure,
          amount: subject.amount,
        }),
        title: subject.title,
        context: subject.context,
        amount: subject.amount,
        category: subject.category,
        path: briefingLinePath(signal, subject),
        asOf: sweptAt.toISOString(),
      };
    });
  }

  /** The repository's reads bound to this request's runner and company. */
  private sourceOf(runner: TenantQueryRunner, context: TenantContext): BriefingSource {
    const repository = this.repository;
    return {
      team: (projectIds, membershipId) =>
        repository.team(runner, context, projectIds, membershipId),
      lastSweep: () => repository.lastSweep(runner, context),
      openSignals: (sweptAt) => repository.openSignals(runner, context, sweptAt),
      subjects: (signals) => repository.subjects(runner, context, signals),
    };
  }
}
