import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DeliverablesService } from './deliverables.service.js';

/** 0211: send-for-approval is one unit (projection + approval + email event); a new version asks again. */
const ORG = 'org-1';
const ctx = { organizationId: ORG } as TenantContext;
const admin = {
  userId: 'u-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'workspace_admin',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: ['p-1'],
  hasOrgWideScope: true,
} as Principal;
const deliverable = { id: 'd-1', projectId: 'p-1', title: 'Homepage' };
const v2 = { id: 'v-2', deliverableId: 'd-1', versionNo: 2, contentHash: 'h'.repeat(64) };
const pending = { id: 'a-1', state: 'requested', version: 1, deliverableVersionId: 'v-1' };

function build() {
  const db = {
    transaction: (_c: unknown, w: (tx: never) => unknown) => w({} as never),
    read: (_c: unknown, w: (tx: never) => unknown) => w({} as never),
  } as unknown as TenantDatabase;
  const repos = {
    deliverables: {
      requireById: vi.fn(async () => deliverable),
      touch: vi.fn(),
      approvalsFor: vi.fn(async () => [pending]),
      clientPeopleFor: vi.fn(async () => [
        {
          userId: 'c-1',
          displayName: 'Youssef',
          role: 'client_reviewer',
          clientOrganizationName: 'Atlas',
        },
      ]),
    },
    versions: {
      latestForDeliverable: vi.fn(async () => v2),
      listForDeliverable: vi.fn(async () => [v2]),
      create: vi.fn(async (_t: unknown, _c: unknown, i: object) => ({
        ...i,
        id: 'v-3',
        createdAt: new Date(),
      })),
    },
    approvals: {
      findByVersion: vi.fn(async () => null),
      open: vi.fn(async (_t: unknown, _c: unknown, _i: object) => ({
        id: 'a-2',
        state: 'requested',
        reviewerIds: ['c-1'],
      })),
      transition: vi.fn(),
    },
    projections: { findByVersion: vi.fn(async () => null), publish: vi.fn() },
    outbox: { append: vi.fn() },
  };
  const service = new DeliverablesService(
    db,
    repos.deliverables as never,
    repos.versions as never,
    repos.approvals as never,
    repos.projections as never,
    {} as never,
    repos.outbox as never,
  );
  return { service, ...repos };
}

describe('DeliverablesService (0211)', () => {
  it('sends the newest version: publishes, opens the approval for the picked approvers, emits approval.requested.v1', async () => {
    const { service, projections, approvals, outbox } = build();
    const sent = await service.send(ctx, admin, 'd-1', 'v-2', {
      approverIds: ['c-1'],
      dueDate: '2026-08-18',
      checkNote: 'Brand feel',
      notify: true,
    });
    expect(sent).toMatchObject({ approvalId: 'a-2', deliverableVersionId: 'v-2' });
    expect(projections.publish).toHaveBeenCalledOnce();
    expect(approvals.open.mock.calls[0]?.[2]).toMatchObject({
      reviewerIds: ['c-1'],
      contentHash: v2.contentHash,
    });
    expect(outbox.append.mock.calls[0]?.[2]).toMatchObject({
      type: 'approval.requested.v1',
      payload: { reviewerUserIds: ['c-1'] },
    });
  });

  it('refuses an approver without approval authority on the project', async () => {
    const { service } = build();
    await expect(
      service.send(ctx, admin, 'd-1', 'v-2', {
        approverIds: ['stranger'],
        dueDate: null,
        checkNote: null,
        notify: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a new version invalidates the approval still pending on the older one and numbers itself next', async () => {
    const { service, approvals, versions } = build();
    const created = await service.addVersion(ctx, admin, 'd-1', {
      fileAssetId: null,
      note: 'Bigger logo',
    });
    expect(approvals.transition.mock.calls[0]?.slice(2, 5)).toEqual(['a-1', 1, 'invalidated']);
    expect(created.versionNo).toBe(3);
    expect(versions.create).toHaveBeenCalledOnce();
  });
});
