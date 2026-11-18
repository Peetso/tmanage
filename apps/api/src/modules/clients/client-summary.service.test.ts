import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { SummarySources } from '../projects/summary-sources.js';
import { ClientSummaryController } from './client-summary.controller.js';
import { CLIENT_SUMMARY_PROJECT_LIMIT, ClientSummaryService } from './client-summary.service.js';
import type { ClientsService } from './clients.service.js';

/**
 * ONEPAGE (B01). The client summary over fake sources with the **real** `authorize()` evaluator:
 * blocks summed over the client's projects equal the sources, an unreadable project contributes
 * nothing, finance blocks follow `finance.view` and their flags, and the parent 404 stops the read.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const CLIENT = 'client-org-0000-0000-0000-000000000001';
const P1 = 'project-0000-0000-0000-0000-000000000001';
const P2 = 'project-0000-0000-0000-0000-000000000002';
const NOW = new Date('2026-11-19T12:00:00Z');

function principal(role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind,
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, correlationId: 'corr' } as TenantContext;
const notFound = () => new ApiError(404, 'not_found', MESSAGES.notFound);

type Clients = Pick<ClientsService, 'getOrganization' | 'listOrganizationProjects'>;

function clients(projectIds: readonly string[] = [P1, P2]): Clients {
  return {
    getOrganization: async () => ({
      id: CLIENT,
      name: 'Acme',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    }),
    listOrganizationProjects: async () =>
      projectIds.map((id) => ({
        id,
        name: `Project ${id.slice(-1)}`,
        status: 'active',
        sharedAt: '2026-02-01T00:00:00.000Z',
      })),
  };
}

function invoice(state: string, currency: string, total: number, paid: number, overdue: boolean) {
  return {
    state,
    currency,
    totalMinor: total,
    paidMinor: paid,
    amountDueMinor: total - paid,
    overdue,
  } as never;
}

function sources(
  overrides: Partial<SummarySources> = {},
  flags = { client_invoicing: true, finance_reports: true },
): SummarySources {
  return {
    health: {
      get: async (_c, _p, projectId) => {
        if (projectId === P2) throw notFound();
        return { band: 'green' } as never;
      },
    },
    work: {
      list: async (_c, _p, options) =>
        options?.projectId === P1
          ? ([
              { id: 'w1', state: 'in_progress', dueAt: '2026-11-01T00:00:00Z' },
              { id: 'w2', state: 'done', dueAt: null },
            ] as never)
          : ([{ id: 'w3', state: 'ready', dueAt: null }] as never),
    },
    milestones: { listInternal: async () => [] },
    deliverables: {
      list: async (_c, _p, projectId) =>
        projectId === P1
          ? ([
              {
                id: 'd1',
                projectId: P1,
                title: 'Logo',
                state: 'in_review',
                updatedAt: '2026-11-10T00:00:00Z',
              },
            ] as never)
          : Promise.reject(notFound()),
    },
    files: {
      listProjectFiles: async (_c, _p, projectId) =>
        [
          {
            id: `f-${projectId.slice(-1)}`,
            projectId,
            name: 'x',
            mimeType: null,
            updatedAt: `2026-11-1${projectId.slice(-1)}T00:00:00Z`,
          },
        ] as never,
    },
    burn: { burn: async () => ({}) as never },
    budget: { get: async () => ({}) as never },
    financeReports: {
      profitability: async () => ({}) as never,
      unbilled: async () =>
        ({
          by: 'client',
          from: '2026-11-01',
          to: '2026-11-30',
          currency: 'EUR',
          truncated: false,
          rows: [
            { clientOrganizationId: CLIENT, minutes: 300, amountMinor: 15000, unpricedMinutes: 0 },
          ],
        }) as never,
    },
    invoices: {
      list: async (_c, _p, query) =>
        query['cursor'] === undefined
          ? {
              invoices: [
                invoice('sent', 'EUR', 10000, 0, true),
                invoice('draft', 'EUR', 999, 0, false),
              ],
              nextCursor: 'page-2',
            }
          : {
              invoices: [
                invoice('partially_paid', 'EUR', 8000, 3000, false),
                invoice('paid', 'USD', 500, 500, false),
              ],
              nextCursor: null,
            },
    },
    flags: async () => flags as never,
    ...overrides,
  };
}

function service(source: SummarySources = sources(), company: Clients = clients()) {
  return new ClientSummaryService(company, source, () => NOW);
}

describe('ClientSummaryService (ONEPAGE B01)', () => {
  it('owner: blocks summed over the projects equal the sources', async () => {
    const view = await service().get(context, principal('owner'), CLIENT);

    expect(view.client).toEqual({ id: CLIENT, name: 'Acme', archivedAt: null });
    expect(view.projects).toEqual({
      items: [
        { id: P1, name: 'Project 1', status: 'active', band: 'green' },
        { id: P2, name: 'Project 2', status: 'active' },
      ],
      truncated: false,
    });
    expect(view.delivery).toEqual({ open: 2, late: 1, done: 1, complete: true });
    expect(view.approvals?.waitingOnClient).toBe(1);
    expect(view.approvals?.items.map((row) => row.deliverableId)).toEqual(['d1']);
    expect(view.files?.items.map((row) => row.id)).toEqual(['f-2', 'f-1']);
    expect(view.money).toEqual({
      totals: [
        {
          currency: 'EUR',
          invoicedMinor: 18000,
          paidMinor: 3000,
          dueMinor: 15000,
          overdueMinor: 10000,
          overdueCount: 1,
        },
        {
          currency: 'USD',
          invoicedMinor: 500,
          paidMinor: 500,
          dueMinor: 0,
          overdueMinor: 0,
          overdueCount: 0,
        },
      ],
      complete: true,
    });
    expect(view.unbilled).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      currency: 'EUR',
      minutes: 300,
      amountMinor: 15000,
      truncated: false,
    });
  });

  it('each finance block is absent while its flag is off', async () => {
    const invoicingOff = await service(
      sources({}, { client_invoicing: false, finance_reports: true }),
    ).get(context, principal('owner'), CLIENT);
    expect('money' in invoicingOff).toBe(false);
    expect(invoicingOff.unbilled).toBeDefined();

    const reportsOff = await service(
      sources({}, { client_invoicing: true, finance_reports: false }),
    ).get(context, principal('owner'), CLIENT);
    expect('unbilled' in reportsOff).toBe(false);
    expect(reportsOff.money).toBeDefined();
  });

  it('without finance.view the finance blocks are absent and the flags are not even read', async () => {
    let flagReads = 0;
    const counting = sources({
      flags: async () => {
        flagReads += 1;
        return { client_invoicing: true, finance_reports: true } as never;
      },
    });
    const view = await service(counting).get(context, principal('member'), CLIENT);
    expect('money' in view).toBe(false);
    expect('unbilled' in view).toBe(false);
    expect(flagReads).toBe(0);
    expect(view.delivery).toBeDefined();
  });

  it('folds in at most the project limit and says so', async () => {
    const many = Array.from(
      { length: CLIENT_SUMMARY_PROJECT_LIMIT + 3 },
      (_, index) => `project-${index}`,
    );
    const view = await service(sources(), clients(many)).get(context, principal('owner'), CLIENT);
    expect(view.projects.items).toHaveLength(CLIENT_SUMMARY_PROJECT_LIMIT);
    expect(view.projects.truncated).toBe(true);
  });

  it('a foreign client company is the parent 404 and no block is read', async () => {
    let reads = 0;
    const counting = sources({
      work: {
        list: async () => {
          reads += 1;
          return [];
        },
      },
    });
    const foreign: Clients = {
      ...clients(),
      getOrganization: async () => Promise.reject(notFound()),
    };
    await expect(
      service(counting, foreign).get(context, principal('owner'), CLIENT),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(reads).toBe(0);
  });

  it('a client principal gets 404', async () => {
    await expect(
      service().get(context, principal('client_admin', 'client'), CLIENT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the route ceiling is org.manage', () => {
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, ClientSummaryController.prototype.get as object),
    ).toBe('org.manage');
  });
});
