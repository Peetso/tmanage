import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { ClientRequestsController } from './client-requests.controller.js';
import { ClientRequestsService } from './client-requests.service.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import type { ClientRequestRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';

/**
 * A7 — "Defer until" with a reminder, "Reopen now", and "Tell <name> it is accepted".
 * Database-free proofs over fakes with the real service and the real `authorize`; the columns
 * themselves (0220) are the chain's to prove against MariaDB.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG, correlationId: 'corr-1' } as unknown as TenantContext;

const manager: Principal = {
  userId: 'user-manager-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: 'membership-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

function row(overrides: Partial<ClientRequestRow> = {}): ClientRequestRow {
  return {
    id: 'req-1',
    organizationId: ORG,
    projectId: 'proj-1',
    clientOrganizationId: 'client-org-1',
    submittedByUserId: 'user-client-1',
    title: 'Add an Arabic version of the menu page',
    category: 'general',
    description: 'Most of our guests are from the Gulf.',
    urgencyReason: null,
    desiredAt: null,
    state: 'triage',
    clarificationQuestion: null,
    clientVisibleReason: null,
    clientSafeScopeSummary: null,
    commitment: null,
    committedAt: null,
    linkedWorkItemId: null,
    deferUntil: null,
    reopenReminder: false,
    deferredByUserId: null,
    version: 2,
    createdAt: new Date('2026-10-20T08:00:00.000Z'),
    updatedAt: new Date('2026-10-20T08:00:00.000Z'),
    ...overrides,
  };
}

function harness(current: ClientRequestRow) {
  const database = {
    read: (_context: unknown, work: (runner: unknown) => unknown) => work({}),
    transaction: (_context: unknown, work: (tx: unknown) => unknown) => work({}),
  } as unknown as TenantDatabase;
  const requests = {
    findById: vi.fn(async () => current),
    transitionState: vi.fn(async (_r, _c, _id, _v, to: string) =>
      row({ ...current, state: to, version: current.version + 1 }),
    ),
    reopenDeferred: vi.fn(async () =>
      row({ ...current, state: 'triage', deferUntil: null, version: current.version + 1 }),
    ),
    submitterNames: vi.fn(async () => new Map([['user-client-1', 'Youssef Adel']])),
  };
  const outbox = { append: vi.fn(async () => undefined) };
  const clientOrganizations = {
    findById: vi.fn(async () => ({ name: 'Atlas Hospitality' })),
    findManyByIds: vi.fn(async () => [{ id: 'client-org-1', name: 'Atlas Hospitality' }]),
  };
  const workItems = { findById: vi.fn(async () => ({ id: 'wi-1', deletedAt: null })) };
  const service = new ClientRequestsService(
    database,
    requests as unknown as ClientRequestsRepository,
    undefined,
    {} as ProjectsRepository,
    workItems as unknown as WorkItemsRepository,
    clientOrganizations as unknown as ClientOrganizationsRepository,
    outbox as unknown as OutboxEventsRepository,
  );
  return { controller: new ClientRequestsController(service), requests, outbox };
}

describe('A7 defer until, with a reminder', () => {
  it('writes the day it comes back, the reminder and who deferred it', async () => {
    const { controller, requests } = harness(row());
    const view = await controller.transition(context, manager, 'req-1', {
      version: 2,
      to: 'deferred',
      clientVisibleReason: 'We will come back to this on Mon 3 Nov.',
      deferUntil: '2026-11-03',
      remindOnReopen: true,
    });
    expect(view.state).toBe('deferred');
    expect(view.submittedByName).toBe('Youssef Adel');
    const call = requests.transitionState.mock.calls[0] as unknown as unknown[];
    expect(call[6]).toEqual({
      until: new Date('2026-11-03T00:00:00.000Z'),
      remindOnReopen: true,
      deferredByUserId: 'user-manager-1',
    });
  });

  it('refuses a defer date on any other move, before anything is written', async () => {
    const { controller, requests } = harness(row());
    await expect(
      controller.transition(context, manager, 'req-1', {
        version: 2,
        to: 'declined',
        clientVisibleReason: 'Out of scope.',
        deferUntil: '2026-11-03',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.transition(context, manager, 'req-1', {
        version: 2,
        to: 'deferred',
        clientVisibleReason: 'Later.',
        deferUntil: '2026-02-31',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests.transitionState).not.toHaveBeenCalled();
  });
});

describe('A7 reopen now', () => {
  it('moves a deferred request back to triage and emits the transition', async () => {
    const { controller, requests, outbox } = harness(
      row({ state: 'deferred', deferUntil: new Date('2026-11-03T00:00:00.000Z') }),
    );
    const view = await controller.reopen(context, manager, 'req-1', { version: 2 });
    expect(view.state).toBe('triage');
    expect(view.deferUntil).toBeNull();
    expect(requests.reopenDeferred).toHaveBeenCalledWith({}, context, 'req-1', 2);
    expect(outbox.append).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({
        payload: expect.objectContaining({ fromStatus: 'deferred', toStatus: 'triage' }),
      }),
    );
  });

  it('refuses a request that is not deferred', async () => {
    const { controller, requests } = harness(row({ state: 'triage' }));
    await expect(
      controller.reopen(context, manager, 'req-1', { version: 2 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(requests.reopenDeferred).not.toHaveBeenCalled();
  });
});

describe('A7 tell the client it is accepted', () => {
  it('marks the event when the box is unticked', async () => {
    const { controller, outbox } = harness(row());
    await controller.accept(context, manager, 'req-1', {
      version: 2,
      clientSafeScopeSummary: 'Arabic version of the menu page',
      commitment: '2026-11-10',
      linkedWorkItemId: 'wi-1',
      notifyClient: false,
    });
    expect(outbox.append).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({ payload: expect.objectContaining({ notifyClient: false }) }),
    );
  });
});
