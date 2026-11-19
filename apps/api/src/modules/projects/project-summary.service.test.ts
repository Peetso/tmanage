import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ProjectSummaryController } from './project-summary.controller.js';
import { ProjectSummaryService } from './project-summary.service.js';
import type { ProjectView } from './projects.service.js';
import type { SummarySources } from './summary-sources.js';

/**
 * ONEPAGE (B01). The project summary over fake sources with the **real** `authorize()` evaluator:
 * the capability matrix per block (a block the viewer may not read is absent from the payload),
 * the parent 404, flag-off and source-refusal absence, and figures equal to what the sources said.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const NOW = new Date('2026-11-19T12:00:00Z');

function principal(
  role: Principal['role'],
  orgWide: boolean,
  kind: Principal['kind'] = 'internal',
): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind,
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: orgWide ? [] : [PROJECT],
    hasOrgWideScope: orgWide,
  };
}

const context = { organizationId: ORG, correlationId: 'corr' } as TenantContext;

const project: ProjectView = {
  id: PROJECT,
  workspaceId: 'workspace-1',
  name: 'Launch',
  status: 'active',
  ownerUserId: null,
  committedAt: '2026-12-01',
  forecastAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  archivedAt: null,
};

const notFound = () => new ApiError(404, 'not_found', MESSAGES.notFound);

function item(id: string, state: string, dueAt: string | null) {
  return { id, state, dueAt } as never;
}

function sources(overrides: Partial<SummarySources> = {}, financeReports = true): SummarySources {
  return {
    health: {
      get: async () =>
        ({
          projectId: PROJECT,
          name: 'Launch',
          status: 'active',
          score: 72,
          band: 'amber',
          signals: {
            overdueMilestones: 1,
            openRisks: 2,
            highRisks: 1,
            objectivesTotal: 0,
            objectivesMet: 0,
            objectivesMissed: 0,
          },
        }) as never,
    },
    work: {
      list: async () => [
        item('w1', 'in_progress', '2026-11-01T00:00:00Z'),
        item('w2', 'ready', '2026-12-01T00:00:00Z'),
        item('w3', 'done', '2026-10-01T00:00:00Z'),
        item('w4', 'archived', null),
      ],
    },
    milestones: {
      listInternal: async () =>
        [
          { id: 'm2', title: 'Beta', dueOn: '2026-12-10', status: 'planned' },
          { id: 'm1', title: 'Alpha', dueOn: '2026-11-25', status: 'planned' },
          { id: 'm0', title: 'Kickoff', dueOn: '2026-10-02', status: 'missed' },
        ] as never,
    },
    deliverables: {
      list: async () =>
        [
          {
            id: 'd1',
            projectId: PROJECT,
            title: 'Logo',
            state: 'in_review',
            updatedAt: '2026-11-10T00:00:00Z',
          },
          {
            id: 'd2',
            projectId: PROJECT,
            title: 'Copy',
            state: 'changes_requested',
            updatedAt: '2026-11-12T00:00:00Z',
          },
          {
            id: 'd3',
            projectId: PROJECT,
            title: 'Old',
            state: 'approved',
            updatedAt: '2026-11-01T00:00:00Z',
          },
        ] as never,
    },
    files: {
      listProjectFiles: async () =>
        [
          {
            id: 'f1',
            projectId: PROJECT,
            name: 'a.pdf',
            mimeType: 'application/pdf',
            updatedAt: '2026-11-01T00:00:00Z',
          },
          {
            id: 'f2',
            projectId: PROJECT,
            name: 'b.png',
            mimeType: 'image/png',
            updatedAt: '2026-11-15T00:00:00Z',
          },
        ] as never,
    },
    burn: {
      burn: async () =>
        ({
          projectId: PROJECT,
          from: '2026-08-27',
          to: '2026-11-19',
          groupBy: 'week',
          buckets: [
            { key: 'w1', minutes: 120, billableMinutes: 90, unpricedMinutes: 0 },
            { key: 'w2', minutes: 60, billableMinutes: 60, unpricedMinutes: 0 },
          ],
          nextCursor: null,
          forecastExhaustedOn: null,
        }) as never,
    },
    budget: {
      get: async () =>
        ({
          budgetHours: 40,
          trackedHours: 3,
          remainingHours: 37,
          burn: { percentBp: 750, remainingMinutes: 2220, status: 'on_track' },
        }) as never,
    },
    financeReports: {
      profitability: async () =>
        ({
          by: 'project',
          from: '2026-11-01',
          to: '2026-11-30',
          currency: 'EUR',
          truncated: false,
          rows: [{ projectId: PROJECT, invoicedMinor: 50000, unbilledMinor: 12000 }],
        }) as never,
      unbilled: async () =>
        ({
          by: 'project',
          from: '2026-11-01',
          to: '2026-11-30',
          currency: 'EUR',
          truncated: false,
          rows: [{ projectId: PROJECT, minutes: 240, amountMinor: 12000, unpricedMinutes: 0 }],
        }) as never,
    },
    invoices: { list: async () => ({ invoices: [], nextCursor: null }) },
    flags: async () => ({ finance_reports: financeReports }) as never,
    // B10: the flag is off unless a case turns signals on.
    signals: { forProject: async () => undefined, forClient: async () => undefined },
    ...overrides,
  };
}

function service(source: SummarySources = sources(), get = async () => project) {
  return new ProjectSummaryService({ get }, source, () => NOW);
}

describe('ProjectSummaryService (ONEPAGE B01)', () => {
  it('owner: every block, each figure equal to its source', async () => {
    const view = await service().get(context, principal('owner', true), PROJECT);

    expect(view.project).toEqual({
      id: PROJECT,
      name: 'Launch',
      status: 'active',
      committedAt: '2026-12-01',
      forecastAt: null,
      archivedAt: null,
    });
    expect(view.delivery).toEqual({ open: 2, late: 1, done: 1, complete: true });
    expect(view.milestone).toEqual({
      next: { id: 'm1', title: 'Alpha', dueOn: '2026-11-25' },
      planned: 2,
      missed: 1,
    });
    expect(view.health).toEqual({
      band: 'amber',
      score: 72,
      overdueMilestones: 1,
      openRisks: 2,
      highRisks: 1,
    });
    expect(view.approvals).toEqual({
      waitingOnTeam: 1,
      waitingOnClient: 1,
      items: [
        {
          deliverableId: 'd1',
          projectId: PROJECT,
          title: 'Logo',
          waitingOn: 'client',
          since: '2026-11-10T00:00:00Z',
        },
        {
          deliverableId: 'd2',
          projectId: PROJECT,
          title: 'Copy',
          waitingOn: 'team',
          since: '2026-11-12T00:00:00Z',
        },
      ],
    });
    expect(view.files?.items.map((file) => file.id)).toEqual(['f2', 'f1']);
    expect(view.time).toEqual({
      from: '2026-08-27',
      to: '2026-11-19',
      loggedMinutes: 180,
      billableMinutes: 150,
    });
    expect(view.budget).toEqual({
      budgetHours: 40,
      trackedHours: 3,
      remainingHours: 37,
      percentBp: 750,
      status: 'on_track',
    });
    expect(view.money).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      currency: 'EUR',
      invoicedMinor: 50000,
      unbilledMinor: 12000,
      unbilledMinutes: 240,
      truncated: false,
    });
  });

  it('member: work, health, approvals, files and time only; manager and finance blocks are absent keys', async () => {
    const view = await service().get(context, principal('member', false), PROJECT);
    expect(Object.keys(view).sort()).toEqual(
      ['approvals', 'delivery', 'files', 'health', 'project', 'time'].sort(),
    );
    expect('money' in view).toBe(false);
    expect('budget' in view).toBe(false);
    expect('milestone' in view).toBe(false);
  });

  it('project manager: holds project.manage and finance.view, so every block is present', async () => {
    const view = await service().get(context, principal('manager', false), PROJECT);
    expect(Object.keys(view).sort()).toEqual([
      'approvals',
      'budget',
      'delivery',
      'files',
      'health',
      'milestone',
      'money',
      'project',
      'time',
    ]);
  });

  it('finance flag off: the money block is absent even for the owner', async () => {
    const view = await service(sources({}, false)).get(context, principal('owner', true), PROJECT);
    expect('money' in view).toBe(false);
    expect(view.budget).toBeDefined();
  });

  it('a source that refuses the viewer leaves its block absent, not the page failing', async () => {
    const refusing = sources({
      files: { listProjectFiles: async () => Promise.reject(notFound()) },
      financeReports: {
        profitability: async () =>
          Promise.reject(new ApiError(403, 'forbidden', MESSAGES.forbidden)),
        unbilled: async () => Promise.reject(new ApiError(403, 'forbidden', MESSAGES.forbidden)),
      },
    });
    const view = await service(refusing).get(context, principal('owner', true), PROJECT);
    expect('files' in view).toBe(false);
    expect('money' in view).toBe(false);
    expect(view.delivery).toBeDefined();
  });

  it('any other source failure is not hidden', async () => {
    const broken = sources({ health: { get: async () => Promise.reject(new Error('db down')) } });
    await expect(service(broken).get(context, principal('owner', true), PROJECT)).rejects.toThrow(
      'db down',
    );
  });

  it('an unreadable project is the parent 404 and no block is read', async () => {
    let reads = 0;
    const counting = sources({
      work: {
        list: async () => {
          reads += 1;
          return [];
        },
      },
    });
    const refused = service(counting, async () => Promise.reject(notFound()));
    await expect(refused.get(context, principal('member', false), PROJECT)).rejects.toMatchObject({
      status: 404,
    });
    expect(reads).toBe(0);
  });

  it('a client principal gets 404: the one-page view is a staff screen', async () => {
    await expect(
      service().get(context, principal('client_admin', false, 'client'), PROJECT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('B10: flag off leaves the payload as today; on, the open signals come through the one reader', async () => {
    const off = await service().get(context, principal('owner', true), PROJECT);
    expect(off).not.toHaveProperty('signals');

    const asked: string[] = [];
    const signals = {
      asOf: '2026-11-19T11:00:00.000Z',
      groups: [{ group: 'stale_work' as const, count: 2, threshold: 14, path: '/work' }],
    };
    const on = await service(
      sources({
        signals: {
          forProject: async (_context, _principal, projectId) => {
            asked.push(projectId);
            return signals;
          },
          forClient: async () => undefined,
        },
      }),
    ).get(context, principal('owner', true), PROJECT);
    expect(on.signals).toEqual(signals);
    expect(asked).toEqual([PROJECT]);
  });

  it('the route ceiling is work.read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, ProjectSummaryController.prototype.get as object),
    ).toBe('work.read');
  });
});
