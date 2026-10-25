import { describe, expect, it, vi } from 'vitest';
import type { ClientRole, Principal } from '@tmanage/domain';
import { hasCapability } from '@tmanage/domain';
import { FEEDBACK_WRITE_CAPABILITY, PortalFeedbackService } from './feedback.service.js';
import type { PortalFeedbackRepository } from './feedback.repository.js';
import type { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientProjectionRow, PortalFeedbackRow } from '../../common/database/schema.js';

/**
 * Wave 9, lane S4 — regression tests for audit run 1 findings F44 (off-project staff read client
 * feedback) and F45 (a read-only client viewer writes feedback), over fakes with the real
 * `authorize()`.
 */

const ORG = 'org-acme';
const CLIENT_ORG = 'client-org-c';
const PROJECT = 'project-p';
const DELIVERABLE = 'deliverable-d';
const VERSION = 'version-1';
const NOW = new Date('2026-10-25T00:00:00.000Z');

const context = { organizationId: ORG, userId: 'caller-1' } as unknown as TenantContext;

function client(role: ClientRole): Principal {
  return {
    userId: 'caller-1',
    organizationId: ORG,
    kind: 'client',
    role,
    membershipId: 'cm-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function manager(projectIds: readonly string[]): Principal {
  return {
    userId: 'manager-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function serviceWith(): {
  service: PortalFeedbackService;
  upsert: ReturnType<typeof vi.fn>;
  listByVersion: ReturnType<typeof vi.fn>;
} {
  const projections = {
    findLatestByDeliverable: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(
        id === DELIVERABLE
          ? ({
              deliverableId: DELIVERABLE,
              projectId: PROJECT,
              deliverableVersionId: VERSION,
            } as unknown as ClientProjectionRow)
          : null,
      ),
  } as unknown as ClientProjectionsRepository;
  const row = {
    id: 'feedback-1',
    organizationId: ORG,
    deliverableVersionId: VERSION,
    clientContactUserId: 'client-contact-1',
    rating: 2,
    comment: 'dummy',
    createdAt: NOW,
    updatedAt: NOW,
  } as PortalFeedbackRow;
  const upsert = vi.fn(() => Promise.resolve(row));
  const listByVersion = vi.fn(() => Promise.resolve([row]));
  const repo = { upsert, listByVersion } as unknown as PortalFeedbackRepository;
  return {
    service: new PortalFeedbackService(fakeDatabase(), projections, repo),
    upsert,
    listByVersion,
  };
}

describe('F44: client feedback is read only by staff on the project (or with org-wide scope)', () => {
  it('answers 404 to a manager who is not on the deliverable project, and reads nothing', async () => {
    const { service, listByVersion } = serviceWith();
    await expect(
      service.listForDeliverable(context, manager([]), DELIVERABLE),
    ).rejects.toMatchObject({ status: 404 });
    expect(listByVersion).not.toHaveBeenCalled();
  });

  it('still lets a manager on the project read it', async () => {
    const { service } = serviceWith();
    const rows = await service.listForDeliverable(context, manager([PROJECT]), DELIVERABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientContactUserId).toBe('client-contact-1');
  });

  it('still lets an org-wide admin read it without a project row', async () => {
    const { service } = serviceWith();
    const admin: Principal = { ...manager([]), role: 'org_admin', hasOrgWideScope: true };
    await expect(service.listForDeliverable(context, admin, DELIVERABLE)).resolves.toHaveLength(1);
  });
});

describe('F45: a read-only client viewer cannot leave feedback', () => {
  it('gates the write on a capability client_viewer lacks and every other client role holds', () => {
    expect(hasCapability('client_viewer', FEEDBACK_WRITE_CAPABILITY)).toBe(false);
    for (const role of ['client_admin', 'client_reviewer', 'client_member'] as const) {
      expect(hasCapability(role, FEEDBACK_WRITE_CAPABILITY)).toBe(true);
    }
  });

  it('answers 403 to a client viewer and writes no row', async () => {
    const { service, upsert } = serviceWith();
    await expect(
      service.submit(context, client('client_viewer'), DELIVERABLE, { rating: 1, comment: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('still lets a client member leave feedback', async () => {
    const { service, upsert } = serviceWith();
    const view = await service.submit(context, client('client_member'), DELIVERABLE, {
      rating: 2,
    });
    expect(view.rating).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
