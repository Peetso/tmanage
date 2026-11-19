import { assembleBriefing, briefingViewerBase } from '@tmanage/domain';
import type {
  BriefingAudience,
  BriefingGroup,
  BriefingSource,
  BriefingViewer,
  BriefingViewerBase,
  Capability,
  Principal,
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
