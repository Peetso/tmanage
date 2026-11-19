import { briefingAudience, briefingSignalVisible, buildBriefing } from '@tmanage/domain';
import type { OpenSignal, Principal, SignalBriefingGroup } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { HomeBriefingRepository } from '../home/home-briefing.repository.js';
import { briefingViewerOf } from '../home/home-briefing.service.js';
import type { FlagReader } from './summary-access.js';
import { SummarySignalsRepository } from './summary-signals.repository.js';

/**
 * B10 ONEPAGE-RISKS — the open signals of one project or one client company, for the Risks block.
 *
 * Not a second rule set: this is the Home briefing (B11) narrowed to one page. The same reads
 * (`HomeBriefingRepository`: the last sweep, the signals it still found, each signal's live
 * record), the same viewer (`briefingViewerOf`), the same visibility (`briefingSignalVisible`:
 * company-wide viewers see everything, a lead their projects, money rules need `finance.view`)
 * and the same grouping and counts (`buildBriefing`). The only thing added is the page's scope:
 * signals of this project, or of the client's projects and the client's own invoices.
 *
 * Absent (`undefined`) when `business_briefing` is off, when the viewer has no briefing at all,
 * or before the first sweep: the Risks block is then exactly what it was without signals.
 */

export interface SummarySignalGroup {
  readonly group: SignalBriefingGroup;
  /** Every signal of the group the viewer may open on this page. */
  readonly count: number;
  /** The threshold the first (most pressing) signal crossed, for the line's words. */
  readonly threshold: number;
  /** Workspace-relative: the one record when the group holds one, else the group's full list. */
  readonly path: string;
}

export interface SummarySignalsBlock {
  /** The sweep the signals come from. */
  readonly asOf: string;
  readonly groups: readonly SummarySignalGroup[];
}

type Scope = (
  runner: TenantQueryRunner,
  signals: readonly OpenSignal[],
) => Promise<readonly OpenSignal[]>;

export class SummarySignalsReader {
  constructor(
    private readonly database: TenantDatabase,
    private readonly flags: FlagReader,
    private readonly briefing: Pick<
      HomeBriefingRepository,
      'lastSweep' | 'openSignals' | 'subjects' | 'team'
    > = new HomeBriefingRepository(),
    private readonly scope: Pick<
      SummarySignalsRepository,
      'clientInvoiceIds'
    > = new SummarySignalsRepository(),
  ) {}

  forProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<SummarySignalsBlock | undefined> {
    return this.read(context, principal, async (_runner, signals) =>
      signals.filter((signal) => signal.projectId === projectId),
    );
  }

  /** The client's projects (those the page folds in) and the invoices of the client itself. */
  forClient(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
    projectIds: readonly string[],
  ): Promise<SummarySignalsBlock | undefined> {
    const projects = new Set(projectIds);
    return this.read(context, principal, async (runner, signals) => {
      const invoiceIds = signals
        .filter((signal) => signal.subjectType === 'client_invoice')
        .map((signal) => signal.subjectId);
      const own = await this.scope.clientInvoiceIds(
        runner,
        context,
        clientOrganizationId,
        invoiceIds,
      );
      return signals.filter(
        (signal) =>
          (signal.projectId !== null && projects.has(signal.projectId)) ||
          (signal.subjectType === 'client_invoice' && own.has(signal.subjectId)),
      );
    });
  }

  private async read(
    context: TenantContext,
    principal: Principal,
    scope: Scope,
  ): Promise<SummarySignalsBlock | undefined> {
    if (principal.kind !== 'internal') return undefined;
    if (!(await this.flags(context)).business_briefing) return undefined;
    return this.database.read(context, async (runner) => {
      // The viewer exactly as Home builds it, team included (B11 `HomeBriefingService`).
      const bare = briefingViewerOf(context, principal);
      const team = bare.companyWide
        ? new Set<string>()
        : await this.briefing.team(runner, context, [...bare.projectIds], principal.membershipId);
      const viewer = briefingViewerOf(context, principal, team);
      if (briefingAudience(viewer) === 'none') return undefined;
      const sweptAt = await this.briefing.lastSweep(runner, context);
      if (sweptAt === null) return undefined;
      const open = await this.briefing.openSignals(runner, context, sweptAt);
      const visible = (await scope(runner, open)).filter((signal) =>
        briefingSignalVisible(signal, viewer),
      );
      const subjects = await this.briefing.subjects(runner, context, visible);
      return {
        asOf: sweptAt.toISOString(),
        groups: buildBriefing(visible, subjects, viewer).flatMap((group) => {
          const first = group.lines[0];
          if (first === undefined) return [];
          return [
            {
              group: group.group,
              count: group.count,
              threshold: first.threshold,
              path: group.count === 1 ? first.path : group.path,
            },
          ];
        }),
      };
    });
  }
}
