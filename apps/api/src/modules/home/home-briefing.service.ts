import {
  SIGNAL_FINANCE_CAPABILITY,
  briefingAudience,
  briefingSignalVisible,
  buildBriefing,
} from '@tmanage/domain';
import type { BriefingAudience, BriefingGroup, BriefingViewer, Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
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

const LEAD_CAPABILITY = 'project.manage';

/** The viewer as the briefing reads them; `teamMembershipIds` is filled from the database. */
export function briefingViewerOf(
  context: TenantContext,
  principal: Principal,
  teamMembershipIds: ReadonlySet<string> = new Set(),
): BriefingViewer {
  const leads = context.capabilities.includes(LEAD_CAPABILITY);
  return {
    companyWide: principal.hasOrgWideScope,
    finance: context.capabilities.includes(SIGNAL_FINANCE_CAPABILITY),
    projectIds: new Set(leads ? principal.projectIds : []),
    teamMembershipIds,
  };
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
    return this.database.read(context, async (runner) => {
      const bare = briefingViewerOf(context, principal);
      const team = bare.companyWide
        ? new Set<string>()
        : await this.repository.team(runner, context, [...bare.projectIds], principal.membershipId);
      const viewer = briefingViewerOf(context, principal, team);
      const audience = briefingAudience(viewer);
      if (audience === 'none') return { audience, asOf: null, groups: [] };
      const sweptAt = await this.repository.lastSweep(runner, context);
      if (sweptAt === null) return { audience, asOf: null, groups: [] };
      // Only the signals this viewer may see are resolved; the builder checks again.
      const visible = (await this.repository.openSignals(runner, context, sweptAt)).filter(
        (signal) => briefingSignalVisible(signal, viewer),
      );
      const subjects = await this.repository.subjects(runner, context, visible);
      return {
        audience,
        asOf: sweptAt.toISOString(),
        groups: buildBriefing(visible, subjects, viewer),
      };
    });
  }
}
