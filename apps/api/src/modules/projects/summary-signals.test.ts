import { describe, expect, it } from 'vitest';
import { briefingSubjectKey } from '@tmanage/domain';
import type { BriefingSubject, Capability, OpenSignal, Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SUMMARY_SIGNALS_SQL } from './summary-signals.repository.js';
import { SummarySignalsReader } from './summary-signals.js';

/**
 * B10 ONEPAGE-RISKS — the Risks block's signals are the Home briefing narrowed to one page: flag
 * off reads nothing, a member who leads nothing gets none, a lead only their projects, money
 * groups need `finance.view`, a record that no longer resolves is not counted, each group's count
 * is its signals on this page, and the client page adds the client's own invoices only.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const LED = 'project-0000-0000-0000-0000-00000000000a';
const OTHER = 'project-0000-0000-0000-0000-00000000000b';
const CLIENT = 'client-0000-0000-0000-0000-000000000001';
const SWEPT = new Date('2026-11-19T11:00:00.000Z');

function principal(role: Principal['role'], orgWide: boolean): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: orgWide ? [] : [LED],
    hasOrgWideScope: orgWide,
  };
}

function context(capabilities: readonly Capability[]): TenantContext {
  return { organizationId: ORG, correlationId: 'corr', capabilities } as unknown as TenantContext;
}

const FINANCE: readonly Capability[] = ['work.read', 'project.manage', 'finance.view'];
const NO_FINANCE: readonly Capability[] = ['work.read', 'project.manage'];

function signal(
  id: string,
  rule: OpenSignal['rule'],
  subjectType: OpenSignal['subjectType'],
  projectId: string | null,
): OpenSignal {
  return {
    signalId: id,
    rule,
    subjectType,
    subjectId: `sub-${id}`,
    projectId,
    measure: 9,
    threshold: 7,
  };
}

const SUBJECT: BriefingSubject = {
  title: 'x',
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
};

const database = {
  read: async <T>(_context: TenantContext, work: (runner: never) => Promise<T>) =>
    work(undefined as never),
} as unknown as TenantDatabase;

function reader(
  signals: readonly OpenSignal[],
  options: {
    flag?: boolean;
    sweptAt?: Date | null;
    gone?: readonly string[];
    clientInvoices?: readonly string[];
  } = {},
) {
  const reads = { open: 0 };
  const briefing = {
    lastSweep: async () => (options.sweptAt === undefined ? SWEPT : options.sweptAt),
    openSignals: async () => {
      reads.open += 1;
      return signals;
    },
    team: async () => new Set<string>(),
    subjects: async (_r: never, _c: TenantContext, visible: readonly OpenSignal[]) =>
      new Map(
        visible
          .filter((item) => !(options.gone ?? []).includes(item.signalId))
          .map((item) => [briefingSubjectKey(item.subjectType, item.subjectId), SUBJECT]),
      ),
  };
  const scope = {
    clientInvoiceIds: async (
      _r: never,
      _c: TenantContext,
      _client: string,
      ids: readonly string[],
    ) => new Set(ids.filter((id) => (options.clientInvoices ?? []).includes(id))),
  };
  const flags = async () => ({ business_briefing: options.flag ?? true }) as never;
  return {
    service: new SummarySignalsReader(database, flags, briefing as never, scope as never),
    reads,
  };
}

const PROJECT_SIGNALS = [
  signal('a', 'stale_task', 'work_item', LED),
  signal('b', 'stale_task', 'work_item', LED),
  signal('c', 'project_over_budget', 'project', LED),
  signal('d', 'stale_task', 'work_item', OTHER),
];

describe('SummarySignalsReader (B10, the briefing narrowed to one page)', () => {
  it('flag off: nothing is read, the block stays as today', async () => {
    const { service, reads } = reader(PROJECT_SIGNALS, { flag: false });
    expect(await service.forProject(context(FINANCE), principal('owner', true), LED)).toBe(
      undefined,
    );
    expect(reads.open).toBe(0);
  });

  it('before the first sweep there is nothing to list', async () => {
    const { service } = reader(PROJECT_SIGNALS, { sweptAt: null });
    expect(await service.forProject(context(FINANCE), principal('owner', true), LED)).toBe(
      undefined,
    );
  });

  it("an owner with finance: this project's groups, each count equal to its signals", async () => {
    const view = await reader(PROJECT_SIGNALS).service.forProject(
      context(FINANCE),
      principal('owner', true),
      LED,
    );
    expect(view?.asOf).toBe(SWEPT.toISOString());
    expect(view?.groups.map((group) => [group.group, group.count, group.path])).toEqual([
      ['over_budget', 1, `/projects/sub-c`],
      ['stale_work', 2, '/work'],
    ]);
  });

  it('money groups are absent without finance access', async () => {
    const view = await reader(PROJECT_SIGNALS).service.forProject(
      context(NO_FINANCE),
      principal('owner', true),
      LED,
    );
    expect(view?.groups.map((group) => group.group)).toEqual(['stale_work']);
  });

  it('a record that no longer resolves is not counted', async () => {
    const view = await reader(PROJECT_SIGNALS, { gone: ['b'] }).service.forProject(
      context(NO_FINANCE),
      principal('owner', true),
      LED,
    );
    expect(view?.groups).toEqual([
      { group: 'stale_work', count: 1, threshold: 7, path: '/work/sub-a' },
    ]);
  });

  it('a lead sees their project; another project and a member who leads nothing get none', async () => {
    const lead = principal('manager', false);
    const { service } = reader(PROJECT_SIGNALS);
    expect(
      (await service.forProject(context(NO_FINANCE), lead, LED))?.groups.map((g) => g.count),
    ).toEqual([2]);
    expect((await service.forProject(context(NO_FINANCE), lead, OTHER))?.groups).toEqual([]);
    const member = principal('member', false);
    expect(await service.forProject(context(['work.read']), member, LED)).toBe(undefined);
  });

  it("the client page: its projects' signals and its own invoices, not another client's", async () => {
    const { service } = reader(
      [
        signal('p', 'stale_task', 'work_item', LED),
        signal('mine', 'overdue_invoice', 'client_invoice', null),
        signal('theirs', 'overdue_invoice', 'client_invoice', null),
        signal('x', 'stale_task', 'work_item', OTHER),
      ],
      { clientInvoices: ['sub-mine'] },
    );
    const view = await service.forClient(context(FINANCE), principal('owner', true), CLIENT, [LED]);
    expect(view?.groups.map((group) => [group.group, group.count])).toEqual([
      ['money_to_collect', 1],
      ['stale_work', 1],
    ]);
  });

  it('binds the organization and the client on the scope read', () => {
    expect(SUMMARY_SIGNALS_SQL.clientInvoiceIds(2)).toContain(
      'WHERE organization_id = ? AND client_organization_id = ? AND id IN (?, ?)',
    );
  });
});
